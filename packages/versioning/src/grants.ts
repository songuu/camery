/** Grants are synchronous and literal true; observe mistaken async failures without ever granting them. */
export function synchronousGrant(value: unknown): boolean {
  if (value === true) return true;
  void Promise.resolve(value).catch(() => {});
  return false;
}
