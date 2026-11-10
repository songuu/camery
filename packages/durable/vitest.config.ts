import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/**/*.test.ts'], exclude: ['test/**/*.integration.test.ts'],
  coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/index.ts', 'src/store.ts', 'src/migrate.ts'], thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 } },
} });
