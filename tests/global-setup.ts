import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kassa:kassa@localhost:5432/kassa_test';

/** Один раз на прогон: чистая схема из тех же миграций, что в продакшене. */
export default async function setup() {
  if (!new URL(TEST_DATABASE_URL).pathname.includes('test')) {
    throw new Error('Тесты стирают базу — запускаются только на базе с «test» в имени');
  }
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public',
  );
  await client.end();
  await runMigrations(TEST_DATABASE_URL);
}
