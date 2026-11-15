import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { jwtVerify, SignJWT } from 'jose';
import { AppError } from './errors.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** scrypt с солью: медленный по задумке — подбор пароля дорогой. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected); // сравнение без утечки по времени
}

export interface TokenPayload {
  userId: number;
  role: 'organizer' | 'customer';
}

export async function createToken(
  payload: TokenPayload,
  secret: string,
  ttlMinutes: number,
): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(payload.userId))
    .setIssuedAt()
    .setExpirationTime(`${ttlMinutes}m`)
    .sign(new TextEncoder().encode(secret));
}

export async function readToken(token: string, secret: string): Promise<TokenPayload> {
  try {
    // algorithms задан явно: токен с alg=none или чужим алгоритмом не пройдёт
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2_147_483_647) throw new Error('bad sub');
    if (payload.role !== 'organizer' && payload.role !== 'customer') throw new Error('bad role');
    return { userId, role: payload.role };
  } catch (error) {
    const expired = error instanceof Error && 'code' in error && error.code === 'ERR_JWT_EXPIRED';
    throw expired
      ? new AppError(401, 'token_expired', 'Срок действия входа истёк — войдите заново')
      : new AppError(401, 'invalid_token', 'Неверный токен');
  }
}

// ---------- Подпись вебхуков ----------
// Заголовок как у Stripe: «t=<unix-время>,v1=<hex HMAC-SHA256 от "t.тело">».
// Время внутри подписи защищает от повтора перехваченного запроса через час.

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signWebhook(body: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export function verifyWebhook(
  body: string,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): void {
  const parts = Object.fromEntries((header ?? '').split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) {
    throw new AppError(400, 'bad_signature', 'Нет подписи вебхука или она в неверном формате');
  }
  if (Math.abs(now / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new AppError(400, 'stale_signature', 'Подпись вебхука устарела');
  }
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(v1, 'hex'))) {
    throw new AppError(400, 'bad_signature', 'Подпись вебхука не совпадает');
  }
}

// Самые частые пароли из утечек: их подбирают первыми
const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password1',
  'qwerty123',
  'qwertyuiop',
  '11111111',
  '00000000',
  'iloveyou',
  '12341234',
  '87654321',
  'qwerty12',
  '1q2w3e4r',
  'abc12345',
]);

/** Популярный, однообразный (меньше 4 разных символов) или совпадающий с email пароль. */
export function isWeakPassword(password: string, email: string): boolean {
  const lowered = password.toLowerCase();
  const name = email.toLowerCase().split('@')[0] ?? '';
  return (
    COMMON_PASSWORDS.has(lowered) ||
    new Set(password).size < 4 ||
    lowered === email.toLowerCase() ||
    lowered === name
  );
}
