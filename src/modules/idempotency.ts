import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export interface Stored {
  status: number;
  body: unknown;
  replayed: boolean;
}

/**
 * Idempotency-Key: клиент повторил запрос (обрыв связи, двойной клик) — получает тот же ответ,
 * а действие не выполняется второй раз. Ключ занимается вставкой с ON CONFLICT DO NOTHING —
 * два одновременных запроса с одним ключом не пройдут оба.
 * Ошибки 4xx тоже запоминаются (повтор даст тот же ответ), сбои 5xx — нет: их можно повторить.
 */
export async function idempotent(
  db: Database,
  userId: number,
  key: string | undefined,
  fingerprint: unknown,
  action: () => Promise<{ status: number; body: unknown }>,
): Promise<Stored> {
  if (key === undefined) return { ...(await action()), replayed: false };
  const requestHash = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
  const claimed = await db
    .insert(idempotencyKeys)
    .values({ userId, key, requestHash })
    .onConflictDoNothing()
    .returning();
  const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));

  if (claimed.length === 0) {
    const existing = await db.query.idempotencyKeys.findFirst({ where });
    if (!existing) throw new AppError(409, 'idempotency_in_progress', 'Запрос с этим ключом ещё выполняется');
    if (existing.requestHash !== requestHash) {
      throw new AppError(
        422,
        'idempotency_mismatch',
        'Этот Idempotency-Key уже использован для другого запроса',
      );
    }
    if (existing.statusCode === null) {
      throw new AppError(409, 'idempotency_in_progress', 'Запрос с этим ключом ещё выполняется');
    }
    return { status: existing.statusCode, body: existing.response, replayed: true };
  }

  let result: { status: number; body: unknown };
  try {
    result = await action();
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      result = { status: error.status, body: errorBody(error) };
    } else {
      await db.delete(idempotencyKeys).where(where); // сбой — ключ освобождается, запрос можно повторить
      throw error;
    }
  }
  await db.update(idempotencyKeys).set({ statusCode: result.status, response: result.body }).where(where);
  return { ...result, replayed: false };
}

export const errorBody = (error: AppError) => ({
  error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
});
