import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/private-outline.compose.ts'],testTimeout:180000}});
