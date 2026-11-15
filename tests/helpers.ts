import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, type Database } from '../src/db/client.js';
import type { PaymentGateway, PaymentRequest, WebhookPayload } from '../src/gateway/gateway.js';
import { signWebhook } from '../src/lib/security.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa_test';
export const PASSWORD = 'secret-pass-123';

export const config: Config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-that-is-long-enough-32b',
  WEBHOOK_SECRET: 'test-webhook-secret',
  REGISTRATIONS_PER_HOUR: '10000', // тесты регистрируют десятки пользователей с одного адреса
});

let pool: ReturnType<typeof createDb> | null = null;
export const shared = () => (pool ??= createDb(TEST_DATABASE_URL, 60));
export async function closeShared() {
  await pool?.pool.end();
  pool = null;
}

/** Поддельный платёжный сервис: запоминает платежи и возвраты, вебхуки тест шлёт сам. */
export class FakeGateway implements PaymentGateway {
  payments: (PaymentRequest & { paymentId: string })[] = [];
  refunds: { paymentId: string; amount: number }[] = [];
  fail = false;
  private n = 0;

  createPayment(request: PaymentRequest) {
    if (this.fail) return Promise.reject(new Error('Шлюз недоступен'));
    const paymentId = `pay_test_${++this.n}`;
    this.payments.push({ ...request, paymentId });
    return Promise.resolve({ paymentId });
  }

  refund(paymentId: string, amount: number) {
    this.refunds.push({ paymentId, amount });
    return Promise.resolve();
  }
}

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  gateway: FakeGateway;
}

export async function makeApp(overrides: Partial<Config> = {}): Promise<TestContext> {
  const gateway = new FakeGateway();
  const db = shared().db;
  const app = await buildApp({ config: { ...config, ...overrides }, db, gateway });
  await app.ready();
  return { app, db, gateway };
}

let counter = 0;

export interface Actor {
  id: number;
  token: string;
  email: string;
  headers: { authorization: string };
}

export async function register(
  app: FastifyInstance,
  role: 'organizer' | 'customer' = 'customer',
  name = 'Айбол',
): Promise<Actor> {
  const email = `user${++counter}-${Date.now()}@test.kz`;
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, name, password: PASSWORD, role },
  });
  if (response.statusCode !== 201) throw new Error(response.body);
  const body = response.json<{ access_token: string; user: { id: number } }>();
  return {
    id: body.user.id,
    token: body.access_token,
    email,
    headers: { authorization: `Bearer ${body.access_token}` },
  };
}

export const inDays = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

export interface EventInfo {
  id: number;
  seats: {
    id: number;
    section: string;
    row: number;
    number: number;
    price: number;
    status: string;
    mine: boolean;
  }[];
}

/** Опубликованное событие с залом 2 ряда × 5 мест по 5 000 ₸. */
export async function publishedEvent(
  app: FastifyInstance,
  organizer: Actor,
  layout = { rows: 2, seatsPerRow: 5, price: 500000 },
) {
  const created = await app.inject({
    method: 'POST',
    url: '/events',
    headers: organizer.headers,
    payload: {
      title: 'Концерт',
      venue: 'Астана Опера',
      startsAt: inDays(10),
      sections: [{ name: 'Партер', ...layout }],
    },
  });
  if (created.statusCode !== 201) throw new Error(created.body);
  const { id } = created.json<{ id: number }>();
  await app.inject({ method: 'POST', url: `/events/${id}/publish`, headers: organizer.headers });
  const detail = await app.inject({ method: 'GET', url: `/events/${id}` });
  return detail.json<EventInfo>();
}

export function webhook(app: FastifyInstance, payload: WebhookPayload, signature?: string) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks/payments',
    headers: {
      'content-type': 'application/json',
      'x-signature': signature ?? signWebhook(body, config.WEBHOOK_SECRET),
    },
    payload: body,
  });
}

let events = 0;
export const eventId = () => `evt_test_${++events}_${Date.now()}`;
