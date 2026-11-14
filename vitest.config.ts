import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Тесты делят одну базу: файлы идут по очереди, а внутри файла — параллельные запросы там, где проверяется гонка
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/seed.ts', 'src/db/migrate.ts'],
      thresholds: { lines: 90, branches: 85, functions: 90 },
    },
  },
});
