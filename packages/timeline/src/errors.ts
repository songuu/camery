export class TimelineError extends Error {
  override readonly name = 'TimelineError';
  constructor(readonly code: string, readonly where: string, message: string) {
    super(`${code} at ${where}: ${message}`);
  }
}
