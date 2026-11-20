import { z } from 'zod';

/** Настройки из переменных окружения. Неверное значение — падение при старте, а не странное поведение потом. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgresql://kassa:kassa@localhost:5432/kassa'),
  JWT_SECRET: z.string().min(32).default('dev-secret-change-me-in-production-32b'),
  JWT_TTL_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .default(12 * 60),
  // Секрет подписи вебхуков платёжного сервиса: им же подписывает учебный шлюз
  WEBHOOK_SECRET: z.string().min(16).default('dev-webhook-secret-change-me'),
  // Куда учебный шлюз шлёт вебхук. По умолчанию — сам себе
  WEBHOOK_URL: z.url().optional(),
  HOLD_MINUTES: z.coerce.number().int().positive().default(10),
  ORDER_MINUTES: z.coerce.number().int().positive().default(15),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  SWEEP_SECONDS: z.coerce.number().positive().default(30),
  // Демо-аккаунты и события при старте — для живого сайта
  SEED_DEMO: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Регистраций в час с одного адреса: защита от спама. В тестах и нагрузке — выше
  REGISTRATIONS_PER_HOUR: z.coerce.number().int().positive().default(10),
  // Сколько наших прокси дописывают адрес в конец X-Forwarded-For. Левые записи присылает сам клиент,
  // верить им нельзя. 0 — заголовку не доверяем. На Render: «…, клиент, Cloudflare» — 2
  PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // Заголовок с адресом клиента от доверенного прокси: true-client-ip у Cloudflare (Render). Пусто — не используется
  CLIENT_IP_HEADER: z
    .string()
    .regex(/^[a-z0-9-]*$/)
    .default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  // Значения по умолчанию опубликованы в репозитории: с JWT_SECRET любой подпишет себе токен,
  // с WEBHOOK_SECRET — подделает вебхук «оплата прошла» и получит билеты бесплатно
  if (config.NODE_ENV === 'production' && config.JWT_SECRET.startsWith('dev-')) {
    throw new Error('JWT_SECRET по умолчанию нельзя использовать в production');
  }
  if (config.NODE_ENV === 'production' && config.WEBHOOK_SECRET.startsWith('dev-')) {
    throw new Error('WEBHOOK_SECRET по умолчанию нельзя использовать в production');
  }
  return config;
}

/** postgres:// и postgresql:// от хостингов — в обоих случаях драйвер pg понимает. */
export const databaseUrl = (url: string) => url.replace(/^postgres:\/\//, 'postgresql://');
