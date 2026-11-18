import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import type {Pool} from 'pg';

/** Role creation belongs only to these explicit randomized fixtures, never the application host. */
export function formalRoleFixture(admin:Pool,databaseUrl:string){
  const owned:{name:string;password:string;url:string}[]=[];
  return {owned,create:async(label:string,install:(pool:Pool,role:string)=>Promise<void>)=>{
    const name='formal_'+label+'_'+randomBytes(8).toString('hex'),password=randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);
    const url=new URL(databaseUrl);url.username=name;url.password=password;const record={name,password,url:url.href};owned.push(record);await install(admin,name);return record;
  },close:async()=>{for(const role of owned.reverse()){await admin.query(`DROP OWNED BY "${role.name}"`);await admin.query(`DROP ROLE "${role.name}"`);}}};
}
export async function formalFreePort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('Expected owned loopback port');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;}
/** Bounded built-process logs are retained only for safe assertions and never include credential values in diagnostics. */
export function formalBuiltProcess(entry:string,env:Record<string,string|undefined>){
  const child=spawn(process.execPath,[entry],{env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CAMERY_'))),...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='',closed=false;const capture=(chunk:Buffer)=>{if(log.length<65536)log+=chunk.toString('utf8').slice(0,65536-log.length);};child.stdout.on('data',capture);child.stderr.on('data',capture);
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{child.once('exit',(code,signal)=>{closed=true;resolve({code,signal});});child.once('error',()=>{closed=true;log+='Built API process could not start';resolve({code:1,signal:null});});});
  const stop=async()=>{if(!closed)child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([exit,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{if(!closed)child.kill('SIGKILL');reject(new Error('Owned built API did not stop'));},5000);timer.unref();})]);}finally{if(timer)clearTimeout(timer);}};
  return {child,exit,stop,closed:()=>closed,log:()=>log};
}
