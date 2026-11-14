import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';

/** Применить миграции из папки drizzle/ — при старте контейнера и в CI. */
export async function runMigrations(url: string, folder = 'drizzle'): Promise<void> {
  const { db, pool } = createDb(url, 1);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  await runMigrations(loadConfig().DATABASE_URL);
  console.log('Миграции применены');
}
