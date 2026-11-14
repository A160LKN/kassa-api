import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { sweep } from '../modules/orders.js';

/** Периодическая уборка истёкших броней и заказов. Возвращает функцию остановки. */
export function startSweeper(db: Database, seconds: number, log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => {
    sweep(db)
      .then((done) => {
        if (done.orders || done.seats) log.info(done, 'Уборка: освобождены истёкшие брони и заказы');
      })
      .catch((error: unknown) => log.error(error, 'Уборка не удалась'));
  }, seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
