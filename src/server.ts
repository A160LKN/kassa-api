import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { SandboxGateway } from './gateway/gateway.js';
import { startSweeper } from './jobs/sweeper.js';
import { seed } from './seed.js';

const config = loadConfig();
await runMigrations(config.DATABASE_URL);
if (config.SEED_DEMO) await seed(config.DATABASE_URL);
const { db, pool } = createDb(config.DATABASE_URL);
const webhookUrl = config.WEBHOOK_URL ?? `http://127.0.0.1:${config.PORT}/webhooks/payments`;
const gateway = new SandboxGateway(webhookUrl, config.WEBHOOK_SECRET, 800, (m) => app.log.info(m));
const app = await buildApp({ config, db, gateway });
const stopSweeper = startSweeper(db, config.SWEEP_SECONDS, app.log);

const shutdown = async () => {
  stopSweeper();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await app.listen({ port: config.PORT, host: '0.0.0.0' });
