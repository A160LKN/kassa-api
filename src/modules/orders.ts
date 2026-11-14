import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database, Tx } from '../db/client.js';
import { events, orderItems, orders, seats, webhookEvents } from '../db/schema.js';
import { next, TransitionError, type OrderAction, type OrderStatus } from '../domain/order-status.js';
import type { PaymentGateway, WebhookPayload } from '../gateway/gateway.js';
import { AppError, notFound } from '../lib/errors.js';

type OrderRow = typeof orders.$inferSelect;

function transition(order: OrderRow, action: OrderAction): OrderStatus {
  try {
    return next(order.status, action);
  } catch (error) {
    if (error instanceof TransitionError) throw new AppError(409, 'invalid_status', error.message);
    throw error;
  }
}

export async function orderView(db: Database | Tx, id: string) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id) });
  if (!order) throw notFound('Заказ');
  const items = await db
    .select({
      seatId: seats.id,
      section: seats.section,
      row: seats.row,
      number: seats.number,
      price: orderItems.price,
    })
    .from(orderItems)
    .innerJoin(seats, eq(seats.id, orderItems.seatId))
    .where(eq(orderItems.orderId, id))
    .orderBy(asc(seats.section), asc(seats.row), asc(seats.number));
  return { ...order, items };
}

async function lockOrder(tx: Tx, id: string, userId?: number): Promise<OrderRow> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
  // Чужой заказ — 404, а не 403: по номеру нельзя узнать, существует ли он
  if (!order || (userId !== undefined && order.userId !== userId)) throw notFound('Заказ');
  return order;
}

const freeSeatsOf = (tx: Tx, orderId: string) =>
  tx
    .update(seats)
    .set({ status: 'free', heldBy: null, holdExpiresAt: null, orderId: null })
    .where(and(eq(seats.orderId, orderId), eq(seats.status, 'held')));

/** Заказ из своих броней. Бронь продлевается до срока оплаты заказа. */
export async function createOrder(
  db: Database,
  userId: number,
  eventId: number,
  seatIds: number[],
  minutes: number,
) {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(seats)
      .where(inArray(seats.id, seatIds))
      .orderBy(asc(seats.id))
      .for('update');
    const now = new Date();
    const mine = locked.filter(
      (s) =>
        s.eventId === eventId &&
        s.status === 'held' &&
        s.heldBy === userId &&
        s.orderId === null &&
        s.holdExpiresAt !== null &&
        s.holdExpiresAt > now,
    );
    if (mine.length !== seatIds.length) {
      const ok = new Set(mine.map((s) => s.id));
      throw new AppError(409, 'hold_required', 'Сначала забронируйте места — или бронь уже истекла', {
        not_held: seatIds.filter((id) => !ok.has(id)),
      });
    }
    const total = mine.reduce((sum, s) => sum + s.price, 0);
    const [order] = await tx
      .insert(orders)
      .values({ userId, eventId, total, expiresAt: sql`now() + make_interval(mins => ${minutes})` })
      .returning();
    if (!order) throw new Error('Заказ не создан');
    await tx
      .insert(orderItems)
      .values(mine.map((s) => ({ orderId: order.id, seatId: s.id, price: s.price })));
    await tx
      .update(seats)
      .set({ orderId: order.id, holdExpiresAt: order.expiresAt })
      .where(inArray(seats.id, seatIds));
    return orderView(tx, order.id);
  });
}

export async function listOrders(db: Database, userId: number) {
  return db
    .select({
      id: orders.id,
      status: orders.status,
      total: orders.total,
      expiresAt: orders.expiresAt,
      createdAt: orders.createdAt,
      eventTitle: events.title,
      startsAt: events.startsAt,
    })
    .from(orders)
    .innerJoin(events, eq(events.id, orders.eventId))
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(100);
}

export async function getOrder(db: Database, id: string, userId: number) {
  const view = await orderView(db, id);
  if (view.userId !== userId) throw notFound('Заказ');
  return view;
}

export async function cancelOrder(db: Database, id: string, userId: number) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, id, userId);
    if (order.paymentId) {
      throw new AppError(409, 'payment_in_progress', 'Оплата уже идёт — дождитесь результата');
    }
    const status = transition(order, 'cancel');
    await tx.update(orders).set({ status, updatedAt: new Date() }).where(eq(orders.id, id));
    await freeSeatsOf(tx, id);
    return orderView(tx, id);
  });
}

/**
 * Начать оплату. Блокировка строки заказа на время запроса к шлюзу: вебхук о результате
 * подождёт, пока payment_id сохранится, и не разминется с ним.
 */
export async function payOrder(
  db: Database,
  gateway: PaymentGateway,
  id: string,
  userId: number,
  cardToken: string,
) {
  return db.transaction(async (tx) => {
    const order = await lockOrder(tx, id, userId);
    transition(order, 'pay'); // проверка: заказ ещё можно оплатить
    if (order.expiresAt <= new Date()) throw new AppError(409, 'order_expired', 'Время на оплату истекло');
    if (order.paymentId)
      throw new AppError(409, 'payment_in_progress', 'Оплата уже идёт — дождитесь результата');
    const { paymentId } = await gateway.createPayment({ orderId: id, amount: order.total, cardToken });
    await tx
      .update(orders)
      .set({ paymentId, paymentError: null, updatedAt: new Date() })
      .where(eq(orders.id, id));
    return orderView(tx, id);
  });
}

export type WebhookResult = 'paid' | 'failed' | 'refunded' | 'duplicate' | 'ignored';

/**
 * Результат оплаты от платёжного сервиса. Одно событие может прийти несколько раз —
 * повтор отсекает первичный ключ event_id. Оплата, пришедшая после истечения заказа,
 * не продаёт места (их могли уже купить другие) — деньги возвращаются.
 */
export async function handlePaymentWebhook(db: Database, gateway: PaymentGateway, payload: WebhookPayload) {
  let refund: { paymentId: string; amount: number } | null = null;
  const result = await db.transaction(async (tx): Promise<WebhookResult> => {
    const fresh = await tx
      .insert(webhookEvents)
      .values({ eventId: payload.event_id, type: payload.type })
      .onConflictDoNothing()
      .returning();
    if (fresh.length === 0) return 'duplicate';

    const order = await lockOrder(tx, payload.order_id);
    if (order.paymentId !== payload.payment_id) {
      throw new AppError(409, 'payment_mismatch', 'Платёж не относится к этому заказу');
    }
    if (payload.amount !== order.total) {
      throw new AppError(400, 'amount_mismatch', 'Сумма платежа не совпадает с суммой заказа');
    }

    if (payload.type === 'payment.failed') {
      if (order.status !== 'pending_payment') return 'ignored';
      // Можно попробовать другую карту: платёж сбрасывается, заказ ждёт оплаты дальше
      await tx
        .update(orders)
        .set({ paymentId: null, paymentError: payload.reason ?? 'Оплата отклонена', updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      return 'failed';
    }

    const lateForPending = order.status === 'pending_payment' && order.expiresAt <= new Date();
    if (order.status === 'expired' || lateForPending) {
      await tx
        .update(orders)
        .set({
          status: next(lateForPending ? next(order.status, 'expire') : order.status, 'late_payment'),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));
      await freeSeatsOf(tx, order.id);
      refund = { paymentId: payload.payment_id, amount: payload.amount };
      return 'refunded';
    }
    if (order.status !== 'pending_payment') return 'ignored'; // уже оплачен, отменён — ничего не меняем

    await tx
      .update(orders)
      .set({ status: next(order.status, 'pay'), paymentError: null, updatedAt: new Date() })
      .where(eq(orders.id, order.id));
    await tx
      .update(seats)
      .set({ status: 'sold', heldBy: null, holdExpiresAt: null })
      .where(eq(seats.orderId, order.id));
    return 'paid';
  });
  // Возврат — после коммита: внешний вызов не держит транзакцию, а отметка уже сохранена
  const pending = refund as { paymentId: string; amount: number } | null;
  if (pending) await gateway.refund(pending.paymentId, pending.amount);
  return result;
}

/**
 * Уборка: истёкшие заказы и брони. Корректность от неё не зависит (истёкшая бронь и так считается
 * свободной), она нужна, чтобы схема зала и заказы показывали правду. Одним запросом — безопасно
 * запускать в нескольких процессах сразу.
 */
export async function sweep(db: Database): Promise<{ orders: number; seats: number }> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(orders)
      .set({ status: 'expired', updatedAt: new Date() })
      // Заказ с идущей оплатой ждёт вебхук ещё час — потом считается истёкшим (поздняя оплата вернётся)
      .where(
        and(
          eq(orders.status, 'pending_payment'),
          sql`(${orders.paymentId} IS NULL AND ${orders.expiresAt} < now()) OR ${orders.expiresAt} < now() - interval '1 hour'`,
        ),
      )
      .returning({ id: orders.id });
    const freed = await tx
      .update(seats)
      .set({ status: 'free', heldBy: null, holdExpiresAt: null, orderId: null })
      .where(and(eq(seats.status, 'held'), lt(seats.holdExpiresAt, sql`now()`)))
      .returning({ id: seats.id });
    return { orders: expired.length, seats: freed.length };
  });
}
