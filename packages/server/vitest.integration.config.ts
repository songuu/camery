import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/**/*.test.ts'], fileParallelism: false, testTimeout: 45000,
  coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/main.ts', 'src/worker-main.ts','src/bible-worker-main.ts'], thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 } },
} });
