import { and, eq, gt, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { events, seats } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';

export const MAX_SEATS_PER_USER = 10;

/** Место можно занять: свободно, бронь истекла или это моя бронь без заказа. */
const available = (userId: number) =>
  or(
    eq(seats.status, 'free'),
    and(eq(seats.status, 'held'), lt(seats.holdExpiresAt, sql`now()`)),
    and(eq(seats.status, 'held'), eq(seats.heldBy, userId), isNull(seats.orderId)),
  );

/**
 * Бронь мест одним UPDATE с условием «место доступно».
 * Два покупателя одновременно: PostgreSQL выполнит обновления строки по очереди, и второй уже
 * не пройдёт условие — без SELECT … FOR UPDATE и без гонки «проверил, потом записал».
 * Все места или ни одного: не хватило хотя бы одного — транзакция откатывается.
 */
export async function holdSeats(
  db: Database,
  eventId: number,
  userId: number,
  seatIds: number[],
  minutes: number,
) {
  return db.transaction(async (tx) => {
    const event = await tx.query.events.findFirst({ where: eq(events.id, eventId) });
    if (!event || event.status === 'draft') throw notFound('Событие');
    if (event.status === 'cancelled') throw new AppError(409, 'event_cancelled', 'Событие отменено');
    if (event.startsAt <= new Date())
      throw new AppError(409, 'event_started', 'Продажа закрыта: событие уже началось');

    const [current] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(seats)
      .where(
        and(
          eq(seats.eventId, eventId),
          eq(seats.heldBy, userId),
          gt(seats.holdExpiresAt, sql`now()`),
          notInArray(seats.id, seatIds),
        ),
      );
    if ((current?.count ?? 0) + seatIds.length > MAX_SEATS_PER_USER) {
      throw new AppError(
        409,
        'too_many_seats',
        `Одновременно можно держать не больше ${MAX_SEATS_PER_USER} мест`,
      );
    }

    const taken = await tx
      .update(seats)
      .set({
        status: 'held',
        heldBy: userId,
        holdExpiresAt: sql`now() + make_interval(mins => ${minutes})`,
        orderId: null,
      })
      .where(and(eq(seats.eventId, eventId), inArray(seats.id, seatIds), available(userId)))
      .returning({ id: seats.id, holdExpiresAt: seats.holdExpiresAt });

    if (taken.length !== seatIds.length) {
      const got = new Set(taken.map((s) => s.id));
      throw new AppError(409, 'seats_unavailable', 'Часть мест уже заняли — выберите другие', {
        unavailable: seatIds.filter((id) => !got.has(id)),
      });
    }
    return {
      seatIds: taken.map((s) => s.id).sort((a, b) => a - b),
      expiresAt: taken[0]?.holdExpiresAt ?? null,
    };
  });
}

/** Отпустить свои брони, ещё не попавшие в заказ. */
export async function releaseSeats(db: Database, eventId: number, userId: number, seatIds: number[]) {
  const released = await db
    .update(seats)
    .set({ status: 'free', heldBy: null, holdExpiresAt: null })
    .where(
      and(
        eq(seats.eventId, eventId),
        inArray(seats.id, seatIds),
        eq(seats.status, 'held'),
        eq(seats.heldBy, userId),
        isNull(seats.orderId),
      ),
    )
    .returning({ id: seats.id });
  return released.map((s) => s.id).sort((a, b) => a - b);
}
