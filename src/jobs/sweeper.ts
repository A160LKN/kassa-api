import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { sweepIdempotencyKeys } from '../modules/idempotency.js';
import { sweep } from '../modules/orders.js';

/** Периодическая уборка истёкших броней, заказов и старых ключей идемпотентности. Возвращает функцию остановки. */
export function startSweeper(db: Database, seconds: number, log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
    sweep(db)
      .then((done) => {
        if (done.orders || done.seats) log.info(done, 'Уборка: освобождены истёкшие брони и заказы');
      })
      .catch((error: unknown) => log.error(error, 'Уборка не удалась'));
    sweepIdempotencyKeys(db)
      .then((keys) => {
        if (keys) log.info({ keys }, 'Уборка: удалены старые ключи идемпотентности');
      })
      .catch((error: unknown) => log.error(error, 'Уборка ключей идемпотентности не удалась'));
  }, seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
