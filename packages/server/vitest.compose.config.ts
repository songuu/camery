import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['test/private-api.compose.ts'], testTimeout: 120000,
} });
