export class VersioningError extends Error {
  override readonly name = 'VersioningError';
  constructor(readonly code: string, readonly where: string, message: string) {
    super(`${code} at ${where}: ${message}`);
  }
}
