import { buildApp } from '../../src/app.js';
import { config, FakeGateway, makeApp, PASSWORD, register, shared, type TestContext } from '../helpers.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx.app.close();
});

describe('безопасность', () => {
  it('заголовки безопасности и ID запроса на каждом ответе', async () => {
    ctx = await makeApp();
    for (const url of ['/health', '/auth/me', '/nope']) {
      const r = await ctx.app.inject({ method: 'GET', url });
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['strict-transport-security']).toContain('max-age=');
      expect(r.headers['content-security-policy']).toMatch(/^default-src 'none'/);
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('страница документации работает со своей политикой CSP', async () => {
    ctx = await makeApp();
    const r = await ctx.app.inject({ method: 'GET', url: '/docs/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it.each(['12345678', 'password', 'aaaaaaaa', 'abababab', 'weak@test.kz'])(
    'слабый пароль «%s» не принимается',
    async (password) => {
      ctx = await makeApp();
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'weak@test.kz', name: 'W', password },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('weak_password');
    },
  );

  it('регистрации с одного адреса ограничены', async () => {
    ctx = await makeApp({ REGISTRATIONS_PER_HOUR: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: `spam${i}-${Date.now()}@test.kz`, name: 'S', password: PASSWORD },
      });
      statuses.push(r.statusCode);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);
  });

  it('500 не раскрывает подробностей, но даёт ID запроса', async () => {
    // Маршрут, который падает, добавляется до запуска приложения
    const gateway = new FakeGateway();
    const app = await buildApp({ config, db: shared().db, gateway });
    app.get('/boom-for-test', () => {
      throw new Error('секрет из базы');
    });
    await app.ready();
    ctx = { app, db: shared().db, gateway };
    const r = await ctx.app.inject({ method: 'GET', url: '/boom-for-test' });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toEqual({
      code: 'internal',
      message: 'Внутренняя ошибка сервера',
      request_id: r.headers['x-request-id'],
    });
    expect(r.body).not.toContain('секрет');
  });

  it('CORS — только для своего фронтенда', async () => {
    ctx = await makeApp({ CORS_ORIGINS: 'https://kassa.example' });
    const ok = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/auth/me',
      headers: { origin: 'https://kassa.example', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('https://kassa.example');
    const bad = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/auth/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('обычная регистрация с надёжным паролем проходит', async () => {
    ctx = await makeApp();
    const user = await register(ctx.app);
    expect(user.token).toBeTruthy();
  });
});
