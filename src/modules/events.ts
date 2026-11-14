import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { events, orders, seats } from '../db/schema.js';
import type { PaymentGateway } from '../gateway/gateway.js';
import { AppError, notFound } from '../lib/errors.js';
import { next } from '../domain/order-status.js';

export interface SectionLayout {
  name: string;
  rows: number;
  seatsPerRow: number;
  price: number;
}

export const MAX_SEATS_PER_EVENT = 5000;

export async function createEvent(
  db: Database,
  organizerId: number,
  data: { title: string; venue: string; startsAt: Date; sections: SectionLayout[] },
) {
  const total = data.sections.reduce((sum, s) => sum + s.rows * s.seatsPerRow, 0);
  if (total > MAX_SEATS_PER_EVENT) {
    throw new AppError(422, 'too_many_seats', `В зале не больше ${MAX_SEATS_PER_EVENT} мест`);
  }
  if (new Set(data.sections.map((s) => s.name.toLowerCase())).size !== data.sections.length) {
    throw new AppError(422, 'duplicate_section', 'Названия секторов должны различаться');
  }
  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(events)
      .values({ organizerId, title: data.title, venue: data.venue, startsAt: data.startsAt })
      .returning();
    if (!event) throw new Error('Событие не создано');
    const rows = data.sections.flatMap((section) =>
      Array.from({ length: section.rows }, (_, r) =>
        Array.from({ length: section.seatsPerRow }, (_, n) => ({
          eventId: event.id,
          section: section.name,
          row: r + 1,
          number: n + 1,
          price: section.price,
        })),
      ).flat(),
    );
    // Пачками: один INSERT на тысячи строк упрётся в лимит параметров PostgreSQL (65535)
    for (let i = 0; i < rows.length; i += 1000) await tx.insert(seats).values(rows.slice(i, i + 1000));
    return { ...event, seats: rows.length };
  });
}

async function ownEvent(db: Database, id: number, organizerId: number) {
  const event = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!event || event.organizerId !== organizerId) throw notFound('Событие');
  return event;
}

export async function publishEvent(db: Database, id: number, organizerId: number) {
  const event = await ownEvent(db, id, organizerId);
  if (event.status !== 'draft')
    throw new AppError(409, 'invalid_status', 'Опубликовать можно только черновик');
  if (event.startsAt <= new Date())
    throw new AppError(409, 'event_in_past', 'Нельзя опубликовать прошедшее событие');
  const [updated] = await db.update(events).set({ status: 'published' }).where(eq(events.id, id)).returning();
  return updated;
}

/**
 * Отмена события: неоплаченные заказы отменяются, оплаченные — возвращаются через платёжный сервис.
 * Статусы меняются в транзакции, а запросы на возврат — после коммита.
 */
export async function cancelEvent(db: Database, gateway: PaymentGateway, id: number, organizerId: number) {
  const event = await ownEvent(db, id, organizerId);
  if (event.status === 'cancelled') throw new AppError(409, 'invalid_status', 'Событие уже отменено');
  const refunds = await db.transaction(async (tx) => {
    await tx.update(events).set({ status: 'cancelled' }).where(eq(events.id, id));
    const affected = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.eventId, id), inArray(orders.status, ['pending_payment', 'paid'])))
      .for('update');
    const toRefund: { paymentId: string; amount: number }[] = [];
    for (const order of affected) {
      const status = next(order.status, order.status === 'paid' ? 'refund' : 'cancel');
      await tx.update(orders).set({ status, updatedAt: new Date() }).where(eq(orders.id, order.id));
      if (order.status === 'paid' && order.paymentId)
        toRefund.push({ paymentId: order.paymentId, amount: order.total });
    }
    await tx
      .update(seats)
      .set({ status: 'free', heldBy: null, holdExpiresAt: null, orderId: null })
      .where(and(eq(seats.eventId, id), eq(seats.status, 'held')));
    return toRefund;
  });
  for (const refund of refunds) await gateway.refund(refund.paymentId, refund.amount);
  return { refunded: refunds.length };
}

// ---------- Афиша ----------

export const encodeCursor = (startsAt: Date, id: number) =>
  Buffer.from(JSON.stringify([startsAt.toISOString(), id])).toString('base64url');

export function decodeCursor(cursor: string): [Date, number] {
  try {
    const [iso, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, number];
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()) || !Number.isSafeInteger(id)) throw new Error('bad');
    return [date, id];
  } catch {
    throw new AppError(422, 'invalid_cursor', 'Неверный курсор страницы');
  }
}

/**
 * Постранично по курсору (starts_at, id), а не по offset: новое событие в начале списка
 * не сдвинет страницы, и глубокие страницы не замедляются.
 */
export async function listEvents(db: Database, limit: number, cursor?: string) {
  const conditions = [eq(events.status, 'published'), gt(events.startsAt, sql`now()`)];
  if (cursor) {
    const [startsAt, id] = decodeCursor(cursor);
    const after = or(gt(events.startsAt, startsAt), and(eq(events.startsAt, startsAt), gt(events.id, id)));
    if (after) conditions.push(after);
  }
  // Имя таблицы — явно: drizzle подставляет колонку без таблицы, и в подзапросе «id» означал бы id места
  const free = sql<number>`(
    SELECT count(*)::int FROM seats s
    WHERE s.event_id = "events"."id" AND (s.status = 'free' OR (s.status = 'held' AND s.hold_expires_at < now()))
  )`;
  const minPrice = sql<number>`(SELECT min(s.price)::int FROM seats s WHERE s.event_id = "events"."id")`;
  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      venue: events.venue,
      startsAt: events.startsAt,
      free,
      minPrice,
    })
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.startsAt, last.id) : null,
  };
}

/** Схема зала. Истёкшая бронь показывается свободной — так же, как её видит бронирование. */
export async function eventWithSeats(db: Database, id: number, viewerId: number | null) {
  const event = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!event || (event.status === 'draft' && event.organizerId !== viewerId)) throw notFound('Событие');
  const rows = await db
    .select()
    .from(seats)
    .where(eq(seats.eventId, id))
    .orderBy(asc(seats.section), asc(seats.row), asc(seats.number));
  const now = new Date();
  return {
    ...event,
    seats: rows.map((s) => {
      const holdAlive = s.status === 'held' && s.holdExpiresAt !== null && s.holdExpiresAt > now;
      return {
        id: s.id,
        section: s.section,
        row: s.row,
        number: s.number,
        price: s.price,
        status: s.status === 'held' && !holdAlive ? ('free' as const) : s.status,
        mine: holdAlive && viewerId !== null && s.heldBy === viewerId,
      };
    }),
  };
}

export async function salesReport(db: Database, id: number, organizerId: number) {
  await ownEvent(db, id, organizerId);
  const [row] = await db
    .select({
      sold: sql<number>`count(*) FILTER (WHERE status = 'sold')::int`,
      held: sql<number>`count(*) FILTER (WHERE status = 'held' AND hold_expires_at > now())::int`,
      free: sql<number>`count(*) FILTER (WHERE status = 'free' OR (status = 'held' AND hold_expires_at <= now()))::int`,
      revenue: sql<number>`coalesce(sum(price) FILTER (WHERE status = 'sold'), 0)::int`,
    })
    .from(seats)
    .where(eq(seats.eventId, id));
  return row ?? { sold: 0, held: 0, free: 0, revenue: 0 };
}
