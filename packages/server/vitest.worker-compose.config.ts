import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/private-worker.compose.ts'], testTimeout: 120000 } });
