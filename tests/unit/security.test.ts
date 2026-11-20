import { SignJWT } from 'jose';
import { databaseUrl, loadConfig } from '../../src/config.js';
import { AppError } from '../../src/lib/errors.js';
import { decodeCursor, encodeCursor } from '../../src/modules/events.js';
import {
  createToken,
  hashPassword,
  readToken,
  SIGNATURE_TOLERANCE_SECONDS,
  signWebhook,
  verifyPassword,
  verifyWebhook,
} from '../../src/lib/security.js';

const SECRET = 'test-secret-that-is-long-enough-32b';

describe('пароли', () => {
  it('соль: одинаковые пароли — разные хеши; проверка работает', async () => {
    const [a, b] = [await hashPassword('пароль-123'), await hashPassword('пароль-123')];
    expect(a).not.toBe(b);
    expect(await verifyPassword('пароль-123', a)).toBe(true);
    expect(await verifyPassword('пароль-124', a)).toBe(false);
    expect(await verifyPassword('пароль-123', 'испорченный')).toBe(false);
  });
});

describe('токены', () => {
  it('туда и обратно', async () => {
    expect(await readToken(await createToken({ userId: 7, role: 'organizer' }, SECRET, 5), SECRET)).toEqual({
      userId: 7,
      role: 'organizer',
    });
  });

  const reject = async (token: string, code: string) => {
    await expect(readToken(token, SECRET)).rejects.toMatchObject({ status: 401, code });
  };

  it('истёкший', async () => {
    const token = await new SignJWT({ role: 'customer' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('1')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(SECRET));
    await reject(token, 'token_expired');
  });

  it.each([
    [
      'чужой секрет',
      async () => createToken({ userId: 1, role: 'customer' }, 'другой-секрет-длиной-больше-32-байт', 5),
    ],
    [
      'без подписи (alg=none)',
      () => Promise.resolve('eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIiwicm9sZSI6ImN1c3RvbWVyIn0.'),
    ],
    [
      'не число в sub',
      async () =>
        new SignJWT({ role: 'customer' })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject('abc')
          .sign(new TextEncoder().encode(SECRET)),
    ],
    [
      'чужая роль',
      async () =>
        new SignJWT({ role: 'admin' })
          .setProtectedHeader({ alg: 'HS256' })
          .setSubject('1')
          .sign(new TextEncoder().encode(SECRET)),
    ],
    ['мусор', () => Promise.resolve('не-токен')],
  ])('отклоняется: %s', async (_name, make) => reject(await make(), 'invalid_token'));
});

describe('подпись вебхука', () => {
  const body = '{"event_id":"evt_1"}';

  it('правильная подпись принимается', () => {
    expect(() => verifyWebhook(body, signWebhook(body, 'whsec'), 'whsec')).not.toThrow();
  });

  it.each([
    [
      'подменённое тело',
      () => verifyWebhook(body.replace('1', '2'), signWebhook(body, 'whsec'), 'whsec'),
      'bad_signature',
    ],
    ['чужой секрет', () => verifyWebhook(body, signWebhook(body, 'other'), 'whsec'), 'bad_signature'],
    ['без заголовка', () => verifyWebhook(body, undefined, 'whsec'), 'bad_signature'],
    ['мусор в заголовке', () => verifyWebhook(body, 't=abc,v1=xyz', 'whsec'), 'bad_signature'],
    [
      'повтор через 10 минут',
      () =>
        verifyWebhook(
          body,
          signWebhook(body, 'whsec', Date.now() - (SIGNATURE_TOLERANCE_SECONDS + 300) * 1000),
          'whsec',
        ),
      'stale_signature',
    ],
  ])('отклоняется: %s', (_name, check, code) => {
    expect(check).toThrow(AppError);
    try {
      check();
    } catch (error) {
      expect((error as AppError).code).toBe(code);
    }
  });
});

describe('курсор и настройки', () => {
  it('курсор туда и обратно, мусор — 422', () => {
    const date = new Date('2026-12-01T10:00:00Z');
    expect(decodeCursor(encodeCursor(date, 42))).toEqual([date, 42]);
    expect(() => decodeCursor('мусор')).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from('["not-a-date",1]').toString('base64url'))).toThrow(AppError);
  });

  it('в production нельзя оставить секрет по умолчанию', () => {
    const secrets = { JWT_SECRET: 'x'.repeat(40), WEBHOOK_SECRET: 'w'.repeat(32) };
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: secrets.JWT_SECRET })).toThrow(
      /WEBHOOK_SECRET/,
    );
    expect(loadConfig({ NODE_ENV: 'production', ...secrets }).NODE_ENV).toBe('production');
  });

  it('неверные значения настроек — ошибка при старте', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow();
  });

  it('SEED_DEMO понимает только true/false, а «false» не превращается в true', () => {
    expect(loadConfig({ SEED_DEMO: 'false' }).SEED_DEMO).toBe(false);
    expect(loadConfig({ SEED_DEMO: 'true' }).SEED_DEMO).toBe(true);
  });

  it('адрес базы от хостинга', () => {
    expect(databaseUrl('postgres://u:p@h/db')).toBe('postgresql://u:p@h/db');
  });
});
