import {z} from 'zod';
import type {Pool} from 'pg';
import {captureContinuity} from '../boundary.js';
import {grantContinuityProfile,verifyContinuityProfile} from './native-role.js';
const Options=z.strictObject({nativeProofs:z.boolean().optional()});
function profile(input:unknown){return captureContinuity(Options,input,'continuity role options',1024).nativeProofs===true?'native_review':'review';}
/** Installer-only grants; native proof reads require an explicit profile, preserving legacy LOGIN authority. */
export async function grantContinuityRuntimeRole(pool:Pool,role:string,options:Readonly<{nativeProofs?:boolean}>={}):Promise<void>{await grantContinuityProfile(pool,role,profile(options));}
export async function verifyContinuityRuntimeRole(pool:Pool,options:Readonly<{nativeProofs?:boolean}>={}):Promise<void>{await verifyContinuityProfile(pool,profile(options));}
