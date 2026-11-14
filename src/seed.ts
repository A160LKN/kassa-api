import { eq } from 'drizzle-orm';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { users } from './db/schema.js';
import { hashPassword } from './lib/security.js';
import { createEvent, publishEvent } from './modules/events.js';

/** Демо-данные для живого сайта: организатор, покупатель и два события. Повторный запуск ничего не делает. */
export const DEMO_PASSWORD = 'kassa-demo';

export async function seed(url: string) {
  const { db, pool } = createDb(url, 2);
  try {
    if (await db.query.users.findFirst({ where: eq(users.email, 'organizer@kassa.kz') })) return;
    const hash = await hashPassword(DEMO_PASSWORD);
    const [organizer] = await db
      .insert(users)
      .values([
        { email: 'organizer@kassa.kz', name: 'Организатор', role: 'organizer', passwordHash: hash },
        { email: 'buyer@kassa.kz', name: 'Покупатель', role: 'customer', passwordHash: hash },
      ])
      .returning();
    if (!organizer) return;
    const inDays = (days: number, hour: number) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() + days);
      date.setUTCHours(hour - 5, 0, 0, 0); // время Астаны
      return date;
    };
    for (const data of [
      {
        title: 'Камерный оркестр: Вивальди при свечах',
        venue: 'Астана Опера, малый зал',
        startsAt: inDays(30, 19),
        sections: [
          { name: 'Партер', rows: 8, seatsPerRow: 12, price: 1500000 },
          { name: 'Балкон', rows: 4, seatsPerRow: 10, price: 900000 },
        ],
      },
      {
        title: 'Стендап: новое и лучшее',
        venue: 'Barys Arena, конференц-зал',
        startsAt: inDays(45, 20),
        sections: [{ name: 'Зал', rows: 10, seatsPerRow: 15, price: 600000 }],
      },
    ]) {
      const event = await createEvent(db, organizer.id, data);
      await publishEvent(db, event.id, organizer.id);
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  await seed(loadConfig().DATABASE_URL);
  console.log('Демо-данные готовы');
}
