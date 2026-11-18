import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/private-outline.compose.ts','test/private-outline-adoption.compose.ts'],fileParallelism:false,testTimeout:180000}});
