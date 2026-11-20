import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
// Full native/source proofs run under V8 coverage; keep this budget separate from workflow/model deadlines.
export default defineConfig({...base,test:{...base.test,exclude:[],testTimeout:120000,fileParallelism:false}});
