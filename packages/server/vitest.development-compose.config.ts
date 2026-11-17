import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/private-development.compose.ts'],testTimeout:180000}});
