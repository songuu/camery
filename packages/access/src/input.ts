/** Copy only own data fields: schema parsing must not run accessors on host callback values. */
export function dataRecord(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('Expected data object');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) throw new Error('Unexpected fields');
  return Object.fromEntries(names.map(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) throw new Error('Expected data field');
    return [name, descriptor.value];
  }));
}
export function dataArray(value: unknown, maxLength: number): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected data array');
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (length > maxLength) throw new Error('Too many entries');
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw new Error('Expected data entry');
    result.push(descriptor.value);
  }
  return result;
}
