/**
 * Гонки на настоящем PostgreSQL: такие ошибки не видны ни руками, ни в последовательных тестах —
 * только когда запросы приходят одновременно.
 */
import { eq, sql } from 'drizzle-orm';
import { orders, seats } from '../../src/db/schema.js';
import { holdSeats } from '../../src/modules/seats.js';
import { createOrder, handlePaymentWebhook, sweep } from '../../src/modules/orders.js';
import { idempotent } from '../../src/modules/idempotency.js';
import { AppError } from '../../src/lib/errors.js';
import { eventId, FakeGateway, makeApp, publishedEvent, register, type TestContext } from '../helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await makeApp();
});
afterEach(async () => {
  await ctx.app.close();
});

const outcome = (promises: Promise<unknown>[]) =>
  Promise.allSettled(promises).then((results) => ({
    ok: results.filter((r) => r.status === 'fulfilled').length,
    codes: results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as AppError).code] : [])),
  }));

it('50 покупателей одновременно берут одно место — достаётся ровно одному', async () => {
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  const seatId = event.seats[0]?.id ?? 0;
  const buyers = await Promise.all(Array.from({ length: 50 }, () => register(ctx.app)));

  const { ok, codes } = await outcome(buyers.map((b) => holdSeats(ctx.db, event.id, b.id, [seatId], 10)));

  expect(ok).toBe(1);
  expect(codes).toEqual(Array(49).fill('seats_unavailable'));
  const [seat] = await ctx.db.select().from(seats).where(eq(seats.id, seatId));
  expect(buyers.map((b) => b.id)).toContain(seat?.heldBy);
});

it('пересекающиеся наборы мест: всё или ничего, ни одно место не занято дважды', async () => {
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  const ids = event.seats.map((s) => s.id);
  const buyers = await Promise.all(Array.from({ length: 20 }, () => register(ctx.app)));

  // Каждый хочет три соседних места — наборы пересекаются
  await outcome(buyers.map((b, i) => holdSeats(ctx.db, event.id, b.id, ids.slice(i % 8, (i % 8) + 3), 10)));

  const held = await ctx.db.select().from(seats).where(eq(seats.status, 'held'));
  const perBuyer = new Map<number, number>();
  for (const seat of held) perBuyer.set(seat.heldBy ?? 0, (perBuyer.get(seat.heldBy ?? 0) ?? 0) + 1);
  expect([...perBuyer.values()].every((n) => n === 3)).toBe(true); // никто не получил «часть набора»
});

it('истёкшую бронь может взять другой покупатель', async () => {
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  const [first, second] = [await register(ctx.app), await register(ctx.app)];
  const seatId = event.seats[0]?.id ?? 0;
  await holdSeats(ctx.db, event.id, first.id, [seatId], 10);
  await expect(holdSeats(ctx.db, event.id, second.id, [seatId], 10)).rejects.toMatchObject({
    code: 'seats_unavailable',
  });

  await ctx.db
    .update(seats)
    .set({ holdExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(seats.id, seatId));
  await expect(holdSeats(ctx.db, event.id, second.id, [seatId], 10)).resolves.toMatchObject({
    seatIds: [seatId],
  });
});

it('один Idempotency-Key, 10 одновременных запросов — заказ создаётся один раз', async () => {
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  const buyer = await register(ctx.app);
  const seatIds = [event.seats[0]?.id ?? 0];
  await holdSeats(ctx.db, event.id, buyer.id, seatIds, 10);

  const attempt = () =>
    idempotent(ctx.db, buyer.id, 'double-click-key', { seatIds }, async () => ({
      status: 201,
      body: await createOrder(ctx.db, buyer.id, event.id, seatIds, 15),
    }));
  const results = await Promise.allSettled(Array.from({ length: 10 }, attempt));

  const created = await ctx.db.select().from(orders);
  expect(created).toHaveLength(1);
  const errors = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as AppError).code] : []));
  expect(errors.every((code) => code === 'idempotency_in_progress')).toBe(true);
});

it('вебхук пришёл 5 раз одновременно — заказ оплачивается один раз', async () => {
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  const buyer = await register(ctx.app);
  const seatIds = [event.seats[0]?.id ?? 0];
  await holdSeats(ctx.db, event.id, buyer.id, seatIds, 10);
  const order = await createOrder(ctx.db, buyer.id, event.id, seatIds, 15);
  await ctx.db.update(orders).set({ paymentId: 'pay_1' }).where(eq(orders.id, order.id));

  const gateway = new FakeGateway();
  const payload = {
    event_id: eventId(),
    type: 'payment.succeeded' as const,
    payment_id: 'pay_1',
    order_id: order.id,
    amount: order.total,
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => handlePaymentWebhook(ctx.db, gateway, payload)),
  );

  expect(results.sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'paid']);
  const [seat] = await ctx.db
    .select()
    .from(seats)
    .where(eq(seats.id, seatIds[0] ?? 0));
  expect(seat?.status).toBe('sold');
});

it('уборка освобождает истёкшие брони и заказы, а живые не трогает', async () => {
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  const buyer = await register(ctx.app);
  const [a, b, c] = event.seats.map((s) => s.id);
  await holdSeats(ctx.db, event.id, buyer.id, [a ?? 0, b ?? 0, c ?? 0], 10);
  const order = await createOrder(ctx.db, buyer.id, event.id, [a ?? 0], 15);
  await ctx.db
    .update(orders)
    .set({ expiresAt: sql`now() - interval '1 minute'` })
    .where(eq(orders.id, order.id));
  await ctx.db
    .update(seats)
    .set({ holdExpiresAt: sql`now() - interval '1 minute'` })
    .where(eq(seats.id, a ?? 0));
  await ctx.db
    .update(seats)
    .set({ holdExpiresAt: sql`now() - interval '1 minute'` })
    .where(eq(seats.id, b ?? 0));

  expect(await sweep(ctx.db)).toEqual({ orders: 1, seats: 2 });
  const after = await ctx.db.select().from(seats).where(eq(seats.eventId, event.id));
  expect(after.find((s) => s.id === c)?.status).toBe('held'); // живая бронь осталась
  expect(after.filter((s) => s.status === 'free')).toHaveLength(event.seats.length - 1);
  const [expired] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
  expect(expired?.status).toBe('expired');
  expect(await sweep(ctx.db)).toEqual({ orders: 0, seats: 0 }); // повторный запуск ничего не ломает
});

it('база сама не даёт бронь без владельца или срока', async () => {
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  await expect(
    ctx.db
      .update(seats)
      .set({ status: 'held' })
      .where(eq(seats.id, event.seats[0]?.id ?? 0)),
  ).rejects.toMatchObject({ cause: { constraint: 'seats_hold_consistent' } });
});

it('фоновая уборка запускается по расписанию и останавливается', async () => {
  const { startSweeper } = await import('../../src/jobs/sweeper.js');
  const organizer = await register(ctx.app, 'organizer');
  const event = await publishedEvent(ctx.app, organizer);
  const buyer = await register(ctx.app);
  const seatId = event.seats[0]?.id ?? 0;
  await holdSeats(ctx.db, event.id, buyer.id, [seatId], 10);
  await ctx.db
    .update(seats)
    .set({ holdExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(seats.id, seatId));
  const logged: unknown[] = [];
  const log = { info: (data: unknown) => logged.push(data), error: () => undefined } as never;

  const stop = startSweeper(ctx.db, 0.05, log);
  await expect.poll(() => logged.length, { timeout: 2000 }).toBeGreaterThan(0);
  stop();
  expect(logged[0]).toEqual({ orders: 0, seats: 1 });
});
