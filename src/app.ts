import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { eq, sql } from 'drizzle-orm';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import { users } from './db/schema.js';
import { TEST_CARDS, type PaymentGateway } from './gateway/gateway.js';
import { clientIp } from './lib/client-ip.js';
import { AppError } from './lib/errors.js';
import {
  createToken,
  hashPassword,
  isWeakPassword,
  readToken,
  verifyPassword,
  verifyWebhook,
  type TokenPayload,
} from './lib/security.js';
import * as eventsService from './modules/events.js';
import { errorBody, idempotent } from './modules/idempotency.js';
import * as ordersService from './modules/orders.js';
import { holdSeats, releaseSeats } from './modules/seats.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: TokenPayload | null;
    rawBody?: string;
  }
}

export interface Deps {
  config: Config;
  db: Database;
  gateway: PaymentGateway;
}

const MAX_ID = 2_147_483_647;
const Id = z.coerce.number().int().min(1).max(MAX_ID);
const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Неверный формат email' }).max(254));
const IdempotencyKey = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[\w-]+$/)
  .optional();
const ErrorOut = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
const SeatIds = z
  .array(Id)
  .min(1)
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, 'Места повторяются');

export async function buildApp({ config, db, gateway }: Deps) {
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL, redact: ['req.headers.authorization'] },
    genReqId: () => crypto.randomUUID(),
    // Не true: тогда Fastify брал бы левый адрес X-Forwarded-For, который подделывает клиент.
    // Доверяем только PROXY_HOPS ближайшим прокси (hop 0 — само соединение) — как числовой trustProxy
    trustProxy: (_address: string, hop: number) => hop < config.PROXY_HOPS,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);

  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(',').map((o) => o.trim()),
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['Idempotent-Replayed', 'X-Request-Id'],
  });
  await app.register(rateLimit, { global: false, keyGenerator: (request) => clientIp(request, config) });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Касса API',
        version: '1.0.0',
        description:
          'Продажа билетов: бронь мест на 10 минут, заказ, оплата через платёжный сервис с вебхуком. ' +
          `Тестовые карты: ${Object.entries(TEST_CARDS)
            .map(([token, what]) => `${token} — ${what}`)
            .join('; ')}.`,
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Вебхук проверяется по подписи сырого тела — до разбора JSON, байт в байт как его подписал отправитель
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, body === '' ? {} : JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'bad_json', 'Тело запроса — не JSON'));
    }
  });

  // Заголовки безопасности на каждом ответе. API отдаёт только JSON — ему не нужны ни скрипты, ни стили;
  // страница /docs (Swagger UI) получает свою, более мягкую политику
  app.addHook('onSend', (request, reply, _payload, done) => {
    const docs = request.url.startsWith('/docs');
    void reply.headers({
      'X-Request-Id': request.id,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Content-Security-Policy': docs
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'",
    });
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return reply.status(error.status).send(errorBody(error));
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(422).send({
        error: {
          code: 'validation',
          message: 'Проверьте данные запроса',
          details: { fields: error.validation.map((v) => ({ path: v.instancePath, message: v.message })) },
        },
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply
        .status(429)
        .send({ error: { code: 'too_many_requests', message: 'Слишком много попыток — подождите минуту' } });
    }
    if (status && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request', message: (error as Error).message } });
    }
    request.log.error(error);
    // Подробности — только в журнал; клиент получает код и ID, по которому ошибку можно найти
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Внутренняя ошибка сервера', request_id: request.id } });
  });

  // ---------- Авторизация ----------

  const authenticate = async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError(401, 'unauthorized', 'Нужна авторизация: заголовок Authorization: Bearer <token>');
    }
    request.user = await readToken(header.slice(7), config.JWT_SECRET);
  };
  const optionalAuth = async (request: FastifyRequest) => {
    if (request.headers.authorization) await authenticate(request);
  };
  const role = (needed: TokenPayload['role']) => async (request: FastifyRequest) => {
    await authenticate(request);
    if (request.user?.role !== needed) {
      throw new AppError(
        403,
        'forbidden',
        needed === 'organizer' ? 'Только для организаторов' : 'Только для покупателей',
      );
    }
  };
  const me = (request: FastifyRequest) => {
    if (!request.user) throw new AppError(401, 'unauthorized', 'Нужна авторизация');
    return request.user;
  };

  const send = (reply: FastifyReply, stored: { status: number; body: unknown; replayed: boolean }) => {
    if (stored.replayed) void reply.header('Idempotent-Replayed', 'true');
    return reply.status(stored.status).send(stored.body);
  };

  // ---------- Служебное ----------

  app.get('/', { schema: { hide: true } }, (_request, reply) => reply.redirect('/docs'));
  app.get('/health', { schema: { tags: ['Служебное'] } }, async () => {
    await db.execute(sql`SELECT 1`);
    return { status: 'ok' };
  });

  // ---------- Вход ----------

  const TokenOut = z.object({
    access_token: z.string(),
    user: z.object({
      id: z.number(),
      email: z.string(),
      name: z.string(),
      role: z.enum(['organizer', 'customer']),
    }),
  });

  app.post(
    '/auth/register',
    {
      // Регистрации с одного адреса ограничены: защита от спама аккаунтами
      config: { rateLimit: { max: config.REGISTRATIONS_PER_HOUR, timeWindow: '1 hour' } },
      schema: {
        tags: ['Вход'],
        body: z.strictObject({
          email: Email,
          name: z.string().trim().min(1).max(60),
          password: z.string().min(8).max(128),
          role: z.enum(['organizer', 'customer']).default('customer'),
        }),
        response: { 201: TokenOut, 409: ErrorOut, 422: ErrorOut, 429: ErrorOut },
      },
    },
    async (request, reply) => {
      const { email, name, password, role: userRole } = request.body;
      if (isWeakPassword(password, email)) {
        throw new AppError(
          422,
          'weak_password',
          'Слишком простой пароль: возьмите длиннее и не из популярных',
        );
      }
      const [user] = await db
        .insert(users)
        .values({ email, name, role: userRole, passwordHash: await hashPassword(password) })
        .onConflictDoNothing()
        .returning();
      if (!user) throw new AppError(409, 'email_taken', 'Пользователь с таким email уже зарегистрирован');
      const token = await createToken(
        { userId: user.id, role: user.role },
        config.JWT_SECRET,
        config.JWT_TTL_MINUTES,
      );
      return reply.status(201).send({ access_token: token, user });
    },
  );

  const dummyHash = await hashPassword('timing-equaliser');
  app.post(
    '/auth/login',
    {
      // 5 попыток в минуту на адрес и email: перебор паролей упрётся в лимит
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (request) => {
            const email = (request.body as { email?: unknown } | undefined)?.email;
            return `${clientIp(request, config)}:${typeof email === 'string' ? email.toLowerCase() : ''}`;
          },
        },
      },
      schema: {
        tags: ['Вход'],
        body: z.strictObject({ email: Email, password: z.string().max(128) }),
        response: { 200: TokenOut, 401: ErrorOut, 429: ErrorOut },
      },
    },
    async (request) => {
      const user = await db.query.users.findFirst({ where: eq(users.email, request.body.email) });
      // Пароль проверяется и для несуществующего email: по времени ответа не узнать, кто зарегистрирован
      const valid = await verifyPassword(request.body.password, user?.passwordHash ?? dummyHash);
      if (!user || !valid) throw new AppError(401, 'invalid_credentials', 'Неверный email или пароль');
      const token = await createToken(
        { userId: user.id, role: user.role },
        config.JWT_SECRET,
        config.JWT_TTL_MINUTES,
      );
      return { access_token: token, user };
    },
  );

  app.get(
    '/auth/me',
    { preHandler: authenticate, schema: { tags: ['Вход'], security: [{ bearer: [] }] } },
    async (request) => {
      const user = await db.query.users.findFirst({ where: eq(users.id, me(request).userId) });
      if (!user) throw new AppError(401, 'invalid_token', 'Неверный токен');
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    },
  );

  // ---------- События ----------

  const Section = z.strictObject({
    name: z.string().trim().min(1).max(30),
    rows: z.number().int().min(1).max(100),
    seatsPerRow: z.number().int().min(1).max(100),
    price: z.number().int().min(100).max(100_000_000).describe('Цена в тиынах'),
  });

  app.post(
    '/events',
    {
      preHandler: role('organizer'),
      schema: {
        tags: ['События'],
        security: [{ bearer: [] }],
        body: z.strictObject({
          title: z.string().trim().min(1).max(120),
          venue: z.string().trim().min(1).max(120),
          startsAt: z.coerce.date(),
          sections: z.array(Section).min(1).max(20),
        }),
      },
    },
    async (request, reply) =>
      reply.status(201).send(await eventsService.createEvent(db, me(request).userId, request.body)),
  );

  app.post(
    '/events/:id/publish',
    {
      preHandler: role('organizer'),
      schema: { tags: ['События'], security: [{ bearer: [] }], params: z.object({ id: Id }) },
    },
    async (request) => eventsService.publishEvent(db, request.params.id, me(request).userId),
  );

  app.post(
    '/events/:id/cancel',
    {
      preHandler: role('organizer'),
      schema: { tags: ['События'], security: [{ bearer: [] }], params: z.object({ id: Id }) },
    },
    async (request) => eventsService.cancelEvent(db, gateway, request.params.id, me(request).userId),
  );

  app.get(
    '/events/:id/sales',
    {
      preHandler: role('organizer'),
      schema: { tags: ['События'], security: [{ bearer: [] }], params: z.object({ id: Id }) },
    },
    async (request) => eventsService.salesReport(db, request.params.id, me(request).userId),
  );

  app.get(
    '/events',
    {
      schema: {
        tags: ['События'],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().max(200).optional(),
        }),
      },
    },
    async (request) => eventsService.listEvents(db, request.query.limit, request.query.cursor),
  );

  app.get(
    '/events/:id',
    { preHandler: optionalAuth, schema: { tags: ['События'], params: z.object({ id: Id }) } },
    async (request) => eventsService.eventWithSeats(db, request.params.id, request.user?.userId ?? null),
  );

  // ---------- Бронь ----------

  app.post(
    '/events/:id/holds',
    {
      preHandler: role('customer'),
      schema: {
        tags: ['Бронь'],
        security: [{ bearer: [] }],
        params: z.object({ id: Id }),
        body: z.strictObject({ seat_ids: SeatIds }),
        response: {
          200: z.object({ seatIds: z.array(z.number()), expiresAt: z.date().nullable() }),
          409: ErrorOut,
        },
      },
    },
    async (request) =>
      holdSeats(db, request.params.id, me(request).userId, request.body.seat_ids, config.HOLD_MINUTES),
  );

  app.delete(
    '/events/:id/holds',
    {
      preHandler: role('customer'),
      schema: {
        tags: ['Бронь'],
        security: [{ bearer: [] }],
        params: z.object({ id: Id }),
        body: z.strictObject({ seat_ids: SeatIds }),
      },
    },
    async (request) => ({
      released: await releaseSeats(db, request.params.id, me(request).userId, request.body.seat_ids),
    }),
  );

  // ---------- Заказы ----------

  app.post(
    '/orders',
    {
      preHandler: role('customer'),
      schema: {
        tags: ['Заказы'],
        security: [{ bearer: [] }],
        headers: z.object({ 'idempotency-key': IdempotencyKey }),
        body: z.strictObject({ event_id: Id, seat_ids: SeatIds }),
      },
    },
    async (request, reply) => {
      const { userId } = me(request);
      const { event_id, seat_ids } = request.body;
      const stored = await idempotent(
        db,
        userId,
        request.headers['idempotency-key'],
        ['POST /orders', request.body],
        async () => ({
          status: 201,
          body: JSON.parse(
            JSON.stringify(
              await ordersService.createOrder(db, userId, event_id, seat_ids, config.ORDER_MINUTES),
            ),
          ),
        }),
      );
      return send(reply, stored);
    },
  );

  app.get(
    '/orders',
    { preHandler: role('customer'), schema: { tags: ['Заказы'], security: [{ bearer: [] }] } },
    async (request) => ordersService.listOrders(db, me(request).userId),
  );

  app.get(
    '/orders/:id',
    {
      preHandler: authenticate,
      schema: { tags: ['Заказы'], security: [{ bearer: [] }], params: z.object({ id: z.uuid() }) },
    },
    async (request) => ordersService.getOrder(db, request.params.id, me(request).userId),
  );

  app.post(
    '/orders/:id/pay',
    {
      preHandler: role('customer'),
      schema: {
        tags: ['Заказы'],
        security: [{ bearer: [] }],
        params: z.object({ id: z.uuid() }),
        headers: z.object({ 'idempotency-key': IdempotencyKey }),
        body: z.strictObject({ card_token: z.string().min(1).max(64) }),
      },
    },
    async (request, reply) => {
      const { userId } = me(request);
      const stored = await idempotent(
        db,
        userId,
        request.headers['idempotency-key'],
        ['POST /orders/:id/pay', request.params.id, request.body],
        async () => ({
          status: 202, // результат оплаты придёт вебхуком — заказ станет paid или вернётся ошибка оплаты
          body: JSON.parse(
            JSON.stringify(
              await ordersService.payOrder(db, gateway, request.params.id, userId, request.body.card_token),
            ),
          ),
        }),
      );
      return send(reply, stored);
    },
  );

  app.post(
    '/orders/:id/cancel',
    {
      preHandler: role('customer'),
      schema: { tags: ['Заказы'], security: [{ bearer: [] }], params: z.object({ id: z.uuid() }) },
    },
    async (request) => ordersService.cancelOrder(db, request.params.id, me(request).userId),
  );

  // ---------- Вебхук платёжного сервиса ----------

  const Webhook = z.object({
    event_id: z.string().min(1).max(64),
    type: z.enum(['payment.succeeded', 'payment.failed']),
    payment_id: z.string().min(1).max(64),
    order_id: z.uuid(),
    amount: z.number().int().positive(),
    reason: z.string().max(200).optional(),
  });

  app.post('/webhooks/payments', { schema: { tags: ['Вебхуки'], hide: false } }, async (request) => {
    verifyWebhook(
      request.rawBody ?? '',
      request.headers['x-signature'] as string | undefined,
      config.WEBHOOK_SECRET,
    );
    const parsed = Webhook.safeParse(request.body);
    if (!parsed.success) throw new AppError(422, 'validation', 'Неверный формат вебхука');
    const result = await ordersService.handlePaymentWebhook(db, gateway, parsed.data);
    request.log.info({ event: parsed.data.event_id, result }, 'Вебхук оплаты');
    return { result };
  });

  return app;
}
