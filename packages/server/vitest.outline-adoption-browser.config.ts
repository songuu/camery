import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/outline-adoption-browser.acceptance.ts'],fileParallelism:false,testTimeout:180000,hookTimeout:45000}});
