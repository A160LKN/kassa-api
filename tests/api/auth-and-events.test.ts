import { inDays, makeApp, PASSWORD, publishedEvent, register, type TestContext } from '../helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await makeApp();
});
afterEach(async () => {
  await ctx.app.close();
});

describe('вход', () => {
  it('регистрация, вход и /auth/me', async () => {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: ' Aigerim@Test.KZ ', name: ' Айгерим ', password: PASSWORD },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().user).toMatchObject({ email: 'aigerim@test.kz', name: 'Айгерим', role: 'customer' });
    expect(reg.json().user).not.toHaveProperty('passwordHash'); // хеш пароля не утекает в ответ

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'AIGERIM@test.kz', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${login.json().access_token}` },
    });
    expect(me.json()).toMatchObject({ email: 'aigerim@test.kz', role: 'customer' });
  });

  it('email уникален без учёта регистра', async () => {
    const user = await register(ctx.app);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: user.email.toUpperCase(), name: 'Двойник', password: PASSWORD },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('email_taken');
  });

  it.each([
    [{ email: 'не-email', name: 'А', password: PASSWORD }],
    [{ email: 'a@test.kz', name: '   ', password: PASSWORD }],
    [{ email: 'a@test.kz', name: 'А', password: 'short' }],
    [{ email: 'a@test.kz', name: 'А', password: PASSWORD, role: 'admin' }],
    [{ email: 'a@test.kz', name: 'А', password: PASSWORD, isAdmin: true }], // лишнее поле — ошибка, а не тишина
  ])('неверная регистрация — 422 с полями', async (payload) => {
    const response = await ctx.app.inject({ method: 'POST', url: '/auth/register', payload });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('validation');
  });

  it('неверный пароль и несуществующий email — одинаковый ответ', async () => {
    const user = await register(ctx.app);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: user.email, password: 'wrong-pass' },
    });
    const nobody = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@test.kz', password: 'wrong-pass' },
    });
    expect([wrong.statusCode, nobody.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual(nobody.json());
  });

  it('перебор паролей упирается в лимит: шестая попытка за минуту — 429', async () => {
    const user = await register(ctx.app);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: user.email, password: `guess-${i}xx` },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it.each([{}, { authorization: 'Bearer мусор' }, { authorization: 'Basic abc' }])(
    'без верного токена — 401',
    async (headers) => {
      expect((await ctx.app.inject({ method: 'GET', url: '/auth/me', headers })).statusCode).toBe(401);
    },
  );

  it('битый JSON — 400, а не 500', async () => {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{oops',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('bad_json');
  });
});

describe('события', () => {
  it('организатор создаёт и публикует событие, зал собирается из секторов', async () => {
    const organizer = await register(ctx.app, 'organizer');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/events',
      headers: organizer.headers,
      payload: {
        title: 'Джаз',
        venue: 'Клуб',
        startsAt: inDays(5),
        sections: [
          { name: 'Партер', rows: 3, seatsPerRow: 4, price: 800000 },
          { name: 'Балкон', rows: 1, seatsPerRow: 6, price: 400000 },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'draft', seats: 18 });

    const id = created.json().id as number;
    expect((await ctx.app.inject({ method: 'GET', url: `/events/${id}` })).statusCode).toBe(404); // черновик не виден
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/events/${id}`, headers: organizer.headers })).statusCode,
    ).toBe(200);

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/events/${id}/publish`,
      headers: organizer.headers,
    });
    expect(published.json().status).toBe('published');
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/events/${id}/publish`,
      headers: organizer.headers,
    });
    expect(again.statusCode).toBe(409);
  });

  it('покупатель не может создавать события, организатор — бронировать', async () => {
    const buyer = await register(ctx.app);
    const organizer = await register(ctx.app, 'organizer');
    const event = await publishedEvent(ctx.app, organizer);
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/events',
      headers: buyer.headers,
      payload: {
        title: 'x',
        venue: 'y',
        startsAt: inDays(1),
        sections: [{ name: 'a', rows: 1, seatsPerRow: 1, price: 1000 }],
      },
    });
    expect(create.statusCode).toBe(403);
    const hold = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/holds`,
      headers: organizer.headers,
      payload: { seat_ids: [event.seats[0]?.id] },
    });
    expect(hold.statusCode).toBe(403);
  });

  it.each([
    [{ sections: [{ name: 'A', rows: 100, seatsPerRow: 100, price: 1000 }] }, 'too_many_seats'],
    [
      {
        sections: [
          { name: 'A', rows: 1, seatsPerRow: 1, price: 1000 },
          { name: 'a', rows: 1, seatsPerRow: 1, price: 1000 },
        ],
      },
      'duplicate_section',
    ],
  ])('неверный зал — 422 (%#)', async (layout, code) => {
    const organizer = await register(ctx.app, 'organizer');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/events',
      headers: organizer.headers,
      payload: { title: 'x', venue: 'y', startsAt: inDays(1), ...layout },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(code);
  });

  it('прошедшее событие нельзя опубликовать', async () => {
    const organizer = await register(ctx.app, 'organizer');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/events',
      headers: organizer.headers,
      payload: {
        title: 'Вчера',
        venue: 'y',
        startsAt: inDays(-1),
        sections: [{ name: 'A', rows: 1, seatsPerRow: 1, price: 1000 }],
      },
    });
    const r = await ctx.app.inject({
      method: 'POST',
      url: `/events/${created.json().id}/publish`,
      headers: organizer.headers,
    });
    expect(r.json().error.code).toBe('event_in_past');
  });

  it('чужое событие для организатора — 404', async () => {
    const owner = await register(ctx.app, 'organizer');
    const other = await register(ctx.app, 'organizer');
    const event = await publishedEvent(ctx.app, owner);
    for (const url of [`/events/${event.id}/sales`, `/events/${event.id}/cancel`]) {
      const r = await ctx.app.inject({
        method: url.endsWith('sales') ? 'GET' : 'POST',
        url,
        headers: other.headers,
      });
      expect(r.statusCode).toBe(404);
    }
  });

  it('афиша: постранично по курсору, без пропусков и повторов', async () => {
    const organizer = await register(ctx.app, 'organizer');
    for (let i = 0; i < 5; i++)
      await publishedEvent(ctx.app, organizer, { rows: 1, seatsPerRow: 2, price: 100000 });
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = await ctx.app.inject({ method: 'GET', url: `/events${query}` });
      const body = page.json<{
        items: { id: number; free: number; minPrice: number }[];
        nextCursor: string | null;
      }>();
      seen.push(...body.items.map((e) => e.id));
      expect(body.items.every((e) => e.free === 2 && e.minPrice === 100000)).toBe(true);
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect((await ctx.app.inject({ method: 'GET', url: '/events?cursor=мусор' })).statusCode).toBe(422);
  });

  it.each(['0', '-1', '2147483648', 'abc'])('id вне диапазона (%s) — 422, а не 500', async (id) => {
    expect((await ctx.app.inject({ method: 'GET', url: `/events/${id}` })).statusCode).toBe(422);
  });

  it('здоровье, документация и OpenAPI', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await ctx.app.inject({ method: 'GET', url: '/' })).headers.location).toBe('/docs');
    const spec = (await ctx.app.inject({ method: 'GET', url: '/docs/json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/events/{id}/holds', '/orders/{id}/pay', '/webhooks/payments']),
    );
  });

  it('CORS пускает фронтенд и показывает заголовок повтора', async () => {
    const r = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/orders',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'idempotency-key',
      },
    });
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(r.headers['access-control-allow-headers']).toLowerCase()).toContain('idempotency-key');
  });

  it('у каждого ответа есть X-Request-Id — по нему ищут запрос в логах', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
