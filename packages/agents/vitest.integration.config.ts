import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 45000, fileParallelism: false,
  coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/index.ts', 'src/node/eval-cli.ts'], thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 } },
} });
