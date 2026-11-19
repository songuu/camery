import {Pool} from 'pg';
import type {PoolConfig} from 'pg';

/** Tracks only pools connected to the disposable database, excluding its admin pool. */
export function testDatabaseConnections():{createPool:(config:PoolConfig)=>Pool;waitForDisconnects:()=>Promise<void>}{
  const disconnected:Promise<void>[]=[];
  return {
    createPool(config){
      const pool=new Pool(config);
      pool.on('connect',client=>{disconnected.push(new Promise<void>(resolve=>{client.once('end',()=>resolve());}));});
      return pool;
    },
    async waitForDisconnects(){
      // pg-pool end() can resolve before idle sockets close; wait for every physical connection before dropping its database.
      await Promise.all(disconnected);
    },
  };
}
