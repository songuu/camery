/** Keep cleanup ordered while ensuring one failed resource never prevents release of the rest. */
export async function releaseResources(releases: readonly (() => unknown)[]): Promise<boolean> {
  let success = true;
  for (const release of releases) { try { await release(); } catch { success = false; } }
  return success;
}
/** A failed application hook must not prevent release of the database connections. */
export async function closeServer(app?: { close(): Promise<void> }, pool?: { end(): Promise<void> }): Promise<boolean> {
  return releaseResources([() => app?.close(), () => pool?.end()]);
}
