import { createHash } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export interface Stored {
  status: number;
  body: unknown;
  replayed: boolean;
}

/**
 * Ключ «в работе» дольше этого считается брошенным: процесс упал между захватом ключа и записью ответа.
 * Без этого ключ навсегда отвечал бы 409 «запрос ещё выполняется», и повторить запрос было бы нельзя.
 * С запасом больше любого запроса: самый долгий — оплата, а шлюз отвечает за секунды.
 */
export const ABANDONED_AFTER_SECONDS = 60;
/** Сохранённый ответ нужен для повторов после обрыва связи — сутки с запасом хватает. */
export const KEEP_HOURS = 24;

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
  const where = and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));
  const claim = () =>
    db.insert(idempotencyKeys).values({ userId, key, requestHash }).onConflictDoNothing().returning();
  let claimed = await claim();
  if (claimed.length === 0) {
    // Брошенный ключ освобождаем и занимаем заново. Удаление атомарно: из двух одновременных повторов
    // ключ достанется одному, второй получит обычный ответ «запрос ещё выполняется»
    const abandoned = await db
      .delete(idempotencyKeys)
      .where(
        and(
          where,
          isNull(idempotencyKeys.statusCode),
          lt(idempotencyKeys.createdAt, sql`now() - make_interval(secs => ${ABANDONED_AFTER_SECONDS})`),
        ),
      )
      .returning();
    if (abandoned.length > 0) claimed = await claim();
  }

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

/** Старые ключи больше не нужны: таблица не растёт бесконечно. Возвращает, сколько удалено. */
export async function sweepIdempotencyKeys(db: Database): Promise<number> {
  const removed = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, sql`now() - make_interval(hours => ${KEEP_HOURS})`))
    .returning({ key: idempotencyKeys.key });
  return removed.length;
}
