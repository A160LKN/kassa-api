import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { databaseUrl } from '../config.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createDb(url: string, max = 10): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl(url), max, connectionTimeoutMillis: 5000 });
  return { db: drizzle(pool, { schema }), pool };
}
