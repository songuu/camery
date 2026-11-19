import {defineConfig} from 'vitest/config';
import base from './vitest.config.js';
// Reuse the actual T1.6 source/database fixture; this is a real PG suite, not just another ordinary test run.
export default defineConfig({...base,test:{...base.test,include:['test/**/*.test.ts','../script/test/screenplay-store.integration.test.ts'],exclude:[],testTimeout:45000,fileParallelism:false}});
