import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/outline-browser.acceptance.ts'],testTimeout:180000}});
