import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({...base,test:{...base.test,exclude:[],testTimeout:45000,fileParallelism:false}});
