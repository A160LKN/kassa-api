import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { orders } from '../../src/db/schema.js';
import { SandboxGateway } from '../../src/gateway/gateway.js';
import { signWebhook } from '../../src/lib/security.js';
import {
  config,
  eventId,
  makeApp,
  publishedEvent,
  register,
  shared,
  webhook,
  type Actor,
  type EventInfo,
  type TestContext,
} from '../helpers.js';

let ctx: TestContext;
let organizer: Actor;
let buyer: Actor;
let event: EventInfo;
beforeEach(async () => {
  ctx = await makeApp();
  organizer = await register(ctx.app, 'organizer');
  buyer = await register(ctx.app, 'customer', 'Бауыржан');
  event = await publishedEvent(ctx.app, organizer);
});
afterEach(async () => {
  await ctx.app.close();
});

const seat = (i: number) => event.seats[i]?.id ?? 0;
const hold = (who: Actor, ids: number[]) =>
  ctx.app.inject({
    method: 'POST',
    url: `/events/${event.id}/holds`,
    headers: who.headers,
    payload: { seat_ids: ids },
  });
const order = (who: Actor, ids: number[], key?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/orders',
    headers: { ...who.headers, ...(key ? { 'idempotency-key': key } : {}) },
    payload: { event_id: event.id, seat_ids: ids },
  });
const pay = (who: Actor, id: string, card = 'tok_success', key?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/orders/${id}/pay`,
    headers: { ...who.headers, ...(key ? { 'idempotency-key': key } : {}) },
    payload: { card_token: card },
  });
const view = async (who: Actor, id: string) =>
  (await ctx.app.inject({ method: 'GET', url: `/orders/${id}`, headers: who.headers })).json<{
    status: string;
    total: number;
    paymentId: string | null;
    paymentError: string | null;
    items: { seatId: number }[];
  }>();
const seatStatus = async (id: number, who?: Actor) => {
  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/events/${event.id}`,
    headers: who?.headers ?? {},
  });
  return detail.json<EventInfo>().seats.find((s) => s.id === id);
};

async function paidOrder(ids = [seat(0)]) {
  await hold(buyer, ids);
  const created = (await order(buyer, ids)).json<{ id: string; total: number }>();
  await pay(buyer, created.id);
  const payment = ctx.gateway.payments.at(-1);
  await webhook(ctx.app, {
    event_id: eventId(),
    type: 'payment.succeeded',
    payment_id: payment?.paymentId ?? '',
    order_id: created.id,
    amount: created.total,
  });
  return created;
}

describe('бронь', () => {
  it('держу места: у меня они «мои», у других — заняты', async () => {
    const r = await hold(buyer, [seat(0), seat(1)]);
    expect(r.statusCode).toBe(200);
    expect(r.json().seatIds).toEqual([seat(0), seat(1)]);
    expect(await seatStatus(seat(0), buyer)).toMatchObject({ status: 'held', mine: true });
    expect(await seatStatus(seat(0))).toMatchObject({ status: 'held', mine: false });
  });

  it('занятое место — 409 и список, каких мест не хватило', async () => {
    const rival = await register(ctx.app);
    await hold(rival, [seat(1)]);
    const r = await hold(buyer, [seat(0), seat(1)]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'seats_unavailable', details: { unavailable: [seat(1)] } });
    expect(await seatStatus(seat(0))).toMatchObject({ status: 'free' }); // всё или ничего
  });

  it('повторная бронь своих мест продлевает её, а не падает', async () => {
    await hold(buyer, [seat(0)]);
    expect((await hold(buyer, [seat(0)])).statusCode).toBe(200);
  });

  it('больше 10 мест разом держать нельзя', async () => {
    const big = await publishedEvent(ctx.app, organizer, { rows: 3, seatsPerRow: 5, price: 100000 });
    const ids = big.seats.map((s) => s.id);
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/events/${big.id}/holds`,
      headers: buyer.headers,
      payload: { seat_ids: ids.slice(0, 8) },
    });
    expect(first.statusCode).toBe(200);
    const more = await ctx.app.inject({
      method: 'POST',
      url: `/events/${big.id}/holds`,
      headers: buyer.headers,
      payload: { seat_ids: ids.slice(8, 11) },
    });
    expect(more.json().error.code).toBe('too_many_seats');
  });

  it.each([
    [{ seat_ids: [] }],
    [{ seat_ids: [1, 1] }],
    [{ seat_ids: Array.from({ length: 11 }, (_, i) => i + 1) }],
    [{ seat_ids: ['abc'] }],
  ])('неверный набор мест — 422 (%#)', async (payload) => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/holds`,
      headers: buyer.headers,
      payload,
    });
    expect(r.statusCode).toBe(422);
  });

  it('отпустить бронь: место снова свободно; чужую бронь отпустить нельзя', async () => {
    const rival = await register(ctx.app);
    await hold(buyer, [seat(0)]);
    const foreign = await ctx.app.inject({
      method: 'DELETE',
      url: `/events/${event.id}/holds`,
      headers: rival.headers,
      payload: { seat_ids: [seat(0)] },
    });
    expect(foreign.json()).toEqual({ released: [] });
    const own = await ctx.app.inject({
      method: 'DELETE',
      url: `/events/${event.id}/holds`,
      headers: buyer.headers,
      payload: { seat_ids: [seat(0)] },
    });
    expect(own.json()).toEqual({ released: [seat(0)] });
    expect(await seatStatus(seat(0))).toMatchObject({ status: 'free' });
  });

  it('черновик, отменённое и прошедшее событие не продаются', async () => {
    const draft = await ctx.app.inject({
      method: 'POST',
      url: '/events',
      headers: organizer.headers,
      payload: {
        title: 'Черновик',
        venue: 'y',
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        sections: [{ name: 'A', rows: 1, seatsPerRow: 1, price: 1000 }],
      },
    });
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/events/${draft.json().id}/holds`,
          headers: buyer.headers,
          payload: { seat_ids: [1] },
        })
      ).statusCode,
    ).toBe(404);

    await ctx.app.inject({ method: 'POST', url: `/events/${event.id}/cancel`, headers: organizer.headers });
    expect((await hold(buyer, [seat(0)])).json().error.code).toBe('event_cancelled');

    const soon = await publishedEvent(ctx.app, organizer);
    await shared().db.execute(
      sql`UPDATE events SET starts_at = now() - interval '1 minute' WHERE id = ${soon.id}`,
    );
    const late = await ctx.app.inject({
      method: 'POST',
      url: `/events/${soon.id}/holds`,
      headers: buyer.headers,
      payload: { seat_ids: [soon.seats[0]?.id] },
    });
    expect(late.json().error.code).toBe('event_started');
  });
});

describe('заказ', () => {
  it('без брони заказ не создать', async () => {
    const r = await order(buyer, [seat(0)]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'hold_required', details: { not_held: [seat(0)] } });
  });

  it('заказ из своих броней: сумма — из цен мест, места привязаны к заказу', async () => {
    await hold(buyer, [seat(0), seat(1)]);
    const r = await order(buyer, [seat(0), seat(1)]);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'pending_payment', total: 1000000 });
    expect(r.json().items.map((i: { seatId: number }) => i.seatId)).toEqual([seat(0), seat(1)]);
    expect((await order(buyer, [seat(0)])).json().error.code).toBe('hold_required'); // одно место — в один заказ
  });

  it('Idempotency-Key: повтор возвращает тот же заказ, другой запрос с тем же ключом — 422', async () => {
    await hold(buyer, [seat(0), seat(1)]);
    const first = await order(buyer, [seat(0)], 'order-key-001');
    const again = await order(buyer, [seat(0)], 'order-key-001');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    expect((await shared().db.select().from(orders)).length).toBe(1);

    const other = await order(buyer, [seat(1)], 'order-key-001');
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe('idempotency_mismatch');
  });

  it('ошибка 4xx тоже запоминается: повтор даёт тот же ответ', async () => {
    const first = await order(buyer, [seat(0)], 'failing-key-01');
    const again = await order(buyer, [seat(0)], 'failing-key-01');
    expect([first.statusCode, again.statusCode]).toEqual([409, 409]);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });

  it('чужой заказ не видно и не оплатить', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string }>();
    const rival = await register(ctx.app);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/orders/${created.id}`, headers: rival.headers }))
        .statusCode,
    ).toBe(404);
    expect((await pay(rival, created.id)).statusCode).toBe(404);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/orders/not-a-uuid', headers: buyer.headers })).statusCode,
    ).toBe(422);
  });

  it('отмена заказа освобождает места', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string }>();
    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/orders/${created.id}/cancel`,
      headers: buyer.headers,
    });
    expect(cancelled.json().status).toBe('cancelled');
    expect(await seatStatus(seat(0))).toMatchObject({ status: 'free' });
    expect((await pay(buyer, created.id)).json().error.code).toBe('invalid_status');
  });

  it('список моих заказов', async () => {
    await paidOrder();
    const list = await ctx.app.inject({ method: 'GET', url: '/orders', headers: buyer.headers });
    expect(list.json()).toEqual([expect.objectContaining({ status: 'paid', eventTitle: 'Концерт' })]);
  });
});

describe('оплата и вебхук', () => {
  it('успешная оплата: заказ оплачен, места проданы', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string; total: number }>();
    const started = await pay(buyer, created.id);
    expect(started.statusCode).toBe(202);
    expect(ctx.gateway.payments).toEqual([
      expect.objectContaining({ orderId: created.id, amount: 500000, cardToken: 'tok_success' }),
    ]);

    const payment = ctx.gateway.payments[0]?.paymentId ?? '';
    const hook = await webhook(ctx.app, {
      event_id: eventId(),
      type: 'payment.succeeded',
      payment_id: payment,
      order_id: created.id,
      amount: created.total,
    });
    expect(hook.json()).toEqual({ result: 'paid' });
    expect((await view(buyer, created.id)).status).toBe('paid');
    expect(await seatStatus(seat(0))).toMatchObject({ status: 'sold' });

    const sales = await ctx.app.inject({
      method: 'GET',
      url: `/events/${event.id}/sales`,
      headers: organizer.headers,
    });
    expect(sales.json()).toEqual({ sold: 1, held: 0, free: 9, revenue: 500000 });
  });

  it('отказ банка: заказ ждёт, видна причина, можно оплатить другой картой', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string; total: number }>();
    await pay(buyer, created.id, 'tok_declined');
    expect((await pay(buyer, created.id)).json().error.code).toBe('payment_in_progress'); // двойной клик

    await webhook(ctx.app, {
      event_id: eventId(),
      type: 'payment.failed',
      payment_id: ctx.gateway.payments[0]?.paymentId ?? '',
      order_id: created.id,
      amount: created.total,
      reason: 'Недостаточно средств',
    });
    const failed = await view(buyer, created.id);
    expect(failed).toMatchObject({
      status: 'pending_payment',
      paymentId: null,
      paymentError: 'Недостаточно средств',
    });

    expect((await pay(buyer, created.id)).statusCode).toBe(202);
    await webhook(ctx.app, {
      event_id: eventId(),
      type: 'payment.succeeded',
      payment_id: ctx.gateway.payments[1]?.paymentId ?? '',
      order_id: created.id,
      amount: created.total,
    });
    expect(await view(buyer, created.id)).toMatchObject({ status: 'paid', paymentError: null });
  });

  it('повтор «Оплатить» с тем же ключом не создаёт второй платёж', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string }>();
    await pay(buyer, created.id, 'tok_success', 'pay-key-0001');
    const again = await pay(buyer, created.id, 'tok_success', 'pay-key-0001');
    expect(again.statusCode).toBe(202);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(ctx.gateway.payments).toHaveLength(1);
  });

  it('шлюз недоступен — 500, а ключ можно повторить, когда шлюз ожил', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string }>();
    ctx.gateway.fail = true;
    expect((await pay(buyer, created.id, 'tok_success', 'retry-key-001')).statusCode).toBe(500);
    expect((await view(buyer, created.id)).paymentId).toBeNull(); // транзакция откатилась
    ctx.gateway.fail = false;
    expect((await pay(buyer, created.id, 'tok_success', 'retry-key-001')).statusCode).toBe(202);
  });

  it('оплата пришла после истечения заказа — места не продаются, деньги возвращаются', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string; total: number }>();
    await pay(buyer, created.id);
    await shared()
      .db.update(orders)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(orders.id, created.id));
    const payment = ctx.gateway.payments[0]?.paymentId ?? '';

    const hook = await webhook(ctx.app, {
      event_id: eventId(),
      type: 'payment.succeeded',
      payment_id: payment,
      order_id: created.id,
      amount: created.total,
    });
    expect(hook.json()).toEqual({ result: 'refunded' });
    expect((await view(buyer, created.id)).status).toBe('refunded');
    expect(ctx.gateway.refunds).toEqual([{ paymentId: payment, amount: 500000 }]);
    expect(await seatStatus(seat(0))).toMatchObject({ status: 'free' });
  });

  it('просроченный заказ нельзя оплатить', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string }>();
    await shared()
      .db.update(orders)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(orders.id, created.id));
    expect((await pay(buyer, created.id)).json().error.code).toBe('order_expired');
  });

  it('поддельный, устаревший и битый вебхук — 400, заказ не меняется', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string; total: number }>();
    await pay(buyer, created.id);
    const payload = {
      event_id: eventId(),
      type: 'payment.succeeded' as const,
      payment_id: ctx.gateway.payments[0]?.paymentId ?? '',
      order_id: created.id,
      amount: created.total,
    };
    const body = JSON.stringify(payload);

    for (const signature of [
      signWebhook(body, 'чужой-секрет'),
      signWebhook(body, config.WEBHOOK_SECRET, Date.now() - 3600_000),
      'v1=abc',
    ]) {
      expect((await webhook(ctx.app, payload, signature)).statusCode).toBe(400);
    }
    const tampered = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/payments',
      headers: {
        'content-type': 'application/json',
        'x-signature': signWebhook(body, config.WEBHOOK_SECRET),
      },
      payload: body.replace(String(created.total), '1'), // подменили сумму, подпись — от оригинала
    });
    expect(tampered.statusCode).toBe(400);
    expect((await view(buyer, created.id)).status).toBe('pending_payment');
  });

  it.each([
    ['сумма не совпадает', { amount: 1 }, 'amount_mismatch'],
    ['чужой платёж', { payment_id: 'pay_other' }, 'payment_mismatch'],
  ])('вебхук отклоняется: %s', async (_name, change, code) => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string; total: number }>();
    await pay(buyer, created.id);
    const r = await webhook(ctx.app, {
      event_id: eventId(),
      type: 'payment.succeeded',
      payment_id: ctx.gateway.payments[0]?.paymentId ?? '',
      order_id: created.id,
      amount: created.total,
      ...change,
    });
    expect(r.json().error.code).toBe(code);
    expect((await view(buyer, created.id)).status).toBe('pending_payment');
  });

  it('повтор того же вебхука — duplicate, без повторной обработки', async () => {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string; total: number }>();
    await pay(buyer, created.id);
    const payload = {
      event_id: eventId(),
      type: 'payment.succeeded' as const,
      payment_id: ctx.gateway.payments[0]?.paymentId ?? '',
      order_id: created.id,
      amount: created.total,
    };
    expect((await webhook(ctx.app, payload)).json()).toEqual({ result: 'paid' });
    expect((await webhook(ctx.app, payload)).json()).toEqual({ result: 'duplicate' });
  });

  it('вебхук неверного формата — 422', async () => {
    const body = JSON.stringify({ event_id: 'evt', type: 'payment.weird' });
    const r = await webhook(ctx.app, JSON.parse(body) as never, signWebhook(body, config.WEBHOOK_SECRET));
    expect(r.statusCode).toBe(422);
  });
});

describe('отмена события', () => {
  it('оплаченные заказы возвращаются, неоплаченные отменяются, брони снимаются', async () => {
    const paid = await paidOrder([seat(0)]);
    const other = await register(ctx.app);
    await hold(other, [seat(1)]);
    const pending = (await order(other, [seat(1)])).json<{ id: string }>();
    await hold(buyer, [seat(2)]);

    const r = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/cancel`,
      headers: organizer.headers,
    });
    expect(r.json()).toEqual({ refunded: 1 });
    expect((await view(buyer, paid.id)).status).toBe('refunded');
    expect((await view(other, pending.id)).status).toBe('cancelled');
    expect(ctx.gateway.refunds).toEqual([{ paymentId: ctx.gateway.payments[0]?.paymentId, amount: 500000 }]);
    expect(await seatStatus(seat(2))).toMatchObject({ status: 'free' });
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/events/${event.id}/cancel`,
          headers: organizer.headers,
        })
      ).statusCode,
    ).toBe(409);
  });
});

it('учебный шлюз шлёт подписанный вебхук по HTTP, и заказ становится оплаченным', async () => {
  // Настоящий HTTP: приложение слушает порт, шлюз стучится в него сам — как в продакшене
  const live = await buildApp({
    config,
    db: shared().db,
    gateway: new SandboxGateway('http://127.0.0.1:0/', config.WEBHOOK_SECRET),
  });
  await live.listen({ port: 0, host: '127.0.0.1' });
  const port = (live.server.address() as { port: number }).port;
  await live.close();

  const gateway = new SandboxGateway(`http://127.0.0.1:${port}/webhooks/payments`, config.WEBHOOK_SECRET, 50);
  const app = await buildApp({ config, db: shared().db, gateway });
  await app.listen({ port, host: '127.0.0.1' });
  try {
    await hold(buyer, [seat(0)]);
    const created = (await order(buyer, [seat(0)])).json<{ id: string }>();
    await app.inject({
      method: 'POST',
      url: `/orders/${created.id}/pay`,
      headers: buyer.headers,
      payload: { card_token: 'tok_success' },
    });
    await expect.poll(async () => (await view(buyer, created.id)).status, { timeout: 3000 }).toBe('paid');

    await hold(buyer, [seat(1)]);
    const declined = (await order(buyer, [seat(1)])).json<{ id: string }>();
    await app.inject({
      method: 'POST',
      url: `/orders/${declined.id}/pay`,
      headers: buyer.headers,
      payload: { card_token: 'tok_declined' },
    });
    await expect
      .poll(async () => (await view(buyer, declined.id)).paymentError, { timeout: 3000 })
      .toMatch(/отклонит/);
  } finally {
    await app.close();
  }
});
