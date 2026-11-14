import { afterAll, beforeEach } from 'vitest';
import { closeShared, shared } from './helpers.js';

beforeEach(async () => {
  await shared().pool.query(
    'TRUNCATE users, events, seats, orders, order_items, idempotency_keys, webhook_events RESTART IDENTITY CASCADE',
  );
});

afterAll(closeShared);
