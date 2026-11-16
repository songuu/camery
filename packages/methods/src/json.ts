export class JsonBoundaryError extends Error {
  override readonly name='JsonBoundaryError';
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT',readonly operation:string){super(`JSON ${operation} failed (${code})`);}
}

/** Count logical JSON bytes before copying/serializing; shared references must spend the budget every time. */
export function snapshotJson<T>(input: T, maxBytes=2_097_152, maxArrayLength=8192): T {
  let remaining=maxBytes; const active=new Set<object>();
  let ownError: JsonBoundaryError|undefined;
  const fail=(code:'INVALID_INPUT'|'INPUT_LIMIT',operation:string):never=>{ownError=new JsonBoundaryError(code,operation);throw ownError;};
  const invalid=(): never=>fail('INVALID_INPUT','data properties');
  const spend=(count: number)=>{remaining-=count;if(remaining<0)fail('INPUT_LIMIT','JSON bytes');};
  const string=(value: string)=>{
    // Even ASCII needs at least one byte per UTF-16 unit, so reject giant strings without allocating encoded copies.
    if (value.length>remaining) fail('INPUT_LIMIT','JSON bytes');
    spend(2);
    for(let i=0;i<value.length;i++) {
      const code=value.charCodeAt(i);
      if(code===34||code===92||code===8||code===9||code===10||code===12||code===13)spend(2);
      else if(code<32)spend(6);
      else if(code<128)spend(1);
      else if(code<2048)spend(2);
      else if(code>=0xd800&&code<=0xdbff&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){spend(4);i++;}
      else if(code>=0xd800&&code<=0xdfff)spend(6);
      else spend(3);
    }
  };
  const visit=(value: unknown,depth: number): unknown=>{
    if(depth>48)invalid();
    if(value===null){spend(4);return null;}
    if(typeof value==='string'){string(value);return value;}
    if(typeof value==='boolean'){spend(value?4:5);return value;}
    if(typeof value==='number'&&Number.isFinite(value)){spend(String(value).length);return value;}
    if(!value||typeof value!=='object'||active.has(value))return invalid();
    const array=Array.isArray(value); const prototype=Object.getPrototypeOf(value);
    if(array ? prototype!==Array.prototype : prototype!==Object.prototype&&prototype!==null)invalid();
    // Proxy/getter views must not change the length between the budget check and index validation.
    const length=array?(()=>{
      const descriptor=Object.getOwnPropertyDescriptor(value,'length');
      if(!descriptor||!('value' in descriptor)||typeof descriptor.value!=='number'||!Number.isSafeInteger(descriptor.value)||descriptor.value<0)return invalid();
      if(descriptor.value>maxArrayLength)fail('INPUT_LIMIT','JSON array');
      return descriptor.value as number;
    })():0;
    active.add(value);spend(2);const keys=Reflect.ownKeys(value);
    if(keys.some(key=>typeof key!=='string'))invalid();
    if(array ? keys.length!==length+1 : keys.length>256)invalid();
    let count=0;const result:unknown[]|Record<string,unknown>=array?[]:{};
    for(const key of keys) {
      if(array&&key==='length')continue;
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!descriptor.enumerable||!('value' in descriptor))return invalid();
      if(count++)spend(1);
      if(!array){if(['__proto__','prototype','constructor'].includes(key as string))invalid();string(key as string);spend(1);}
      else if(!/^(0|[1-9]\d*)$/.test(key as string)||Number(key)>=length)invalid();
      const child=visit(descriptor.value,depth+1);
      if(array)(result as unknown[])[Number(key)]=child;else(result as Record<string,unknown>)[key as string]=child;
    }
    active.delete(value);return result;
  };
  try { return visit(input,0) as T; } catch(error) {
    if(ownError!==undefined&&error===ownError)throw error;
    throw new JsonBoundaryError('INVALID_INPUT','data properties');
  }
}
export function guardJson(input: unknown,maxBytes=2_097_152,maxArrayLength=8192):void { snapshotJson(input,maxBytes,maxArrayLength); }
