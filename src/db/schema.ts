import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const role = pgEnum('role', ['organizer', 'customer']);
export const eventStatus = pgEnum('event_status', ['draft', 'published', 'cancelled']);
export const seatStatus = pgEnum('seat_status', ['free', 'held', 'sold']);
export const orderStatus = pgEnum('order_status', [
  'pending_payment',
  'paid',
  'expired',
  'cancelled',
  'refunded',
]);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 254 }).notNull().unique(),
  name: varchar('name', { length: 60 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  role: role('role').notNull(),
  createdAt: createdAt(),
});

export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    organizerId: integer('organizer_id')
      .notNull()
      .references(() => users.id),
    title: varchar('title', { length: 120 }).notNull(),
    venue: varchar('venue', { length: 120 }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    status: eventStatus('status').notNull().default('draft'),
    createdAt: createdAt(),
  },
  (t) => [index('events_listing').on(t.status, t.startsAt, t.id)],
);

/**
 * Место — единственный источник правды о том, свободно ли оно.
 * Бронь — это просто status = 'held' с владельцем и сроком: истёкшая бронь считается свободной
 * прямо в условии UPDATE, поэтому корректность не зависит от фоновой уборки.
 */
export const seats = pgTable(
  'seats',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    section: varchar('section', { length: 30 }).notNull(),
    row: smallint('row').notNull(),
    number: smallint('number').notNull(),
    price: integer('price').notNull(),
    status: seatStatus('status').notNull().default('free'),
    heldBy: integer('held_by').references(() => users.id),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    orderId: uuid('order_id'),
  },
  (t) => [
    unique('seats_place').on(t.eventId, t.section, t.row, t.number),
    index('seats_event').on(t.eventId),
    index('seats_expiring')
      .on(t.holdExpiresAt)
      .where(sql`status = 'held'`),
    check('seats_price_positive', sql`${t.price} > 0`),
    check(
      'seats_hold_consistent',
      sql`(${t.status} = 'held') = (${t.heldBy} IS NOT NULL AND ${t.holdExpiresAt} IS NOT NULL)`,
    ),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    status: orderStatus('status').notNull().default('pending_payment'),
    total: integer('total').notNull(),
    paymentId: varchar('payment_id', { length: 64 }).unique(),
    // Почему не прошла последняя оплата — покупатель видит это и может попробовать другую карту
    paymentError: varchar('payment_error', { length: 200 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_user').on(t.userId, t.createdAt),
    check('orders_total_positive', sql`${t.total} > 0`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    seatId: integer('seat_id')
      .notNull()
      .references(() => seats.id),
    price: integer('price').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.seatId] })],
);

/** Повтор запроса с тем же Idempotency-Key отдаёт сохранённый ответ, а не создаёт второй заказ. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    key: varchar('key', { length: 100 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    statusCode: smallint('status_code'),
    response: jsonb('response'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Обработанные вебхуки: платёжный сервис может прислать одно событие несколько раз. */
export const webhookEvents = pgTable('webhook_events', {
  eventId: varchar('event_id', { length: 64 }).primaryKey(),
  type: varchar('type', { length: 40 }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
