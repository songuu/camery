import {randomBytes} from 'node:crypto';

/** IDs are allocated by the trusted host and persisted before execution; names and user input are never identity seeds. */
export function newProjectObjectId():string{
  try{
    const now=Date.now();if(!Number.isSafeInteger(now)||now<0||now>281474976710655)throw new Error();
    const bytes=randomBytes(10);let value=BigInt(now);for(const byte of bytes)value=value*256n+BigInt(byte);
    const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let id='';for(let index=0;index<26;index++){id=alphabet[Number(value&31n)]+id;value>>=5n;}return id;
  }catch{throw new Error('Project identity allocation unavailable');}
}
