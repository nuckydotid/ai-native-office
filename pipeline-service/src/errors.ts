/** A refusal the routes turn into a status and a sentence. Same shape as the web service's own, so the HTTP driver maps it straight. */
export class ServiceError extends Error {
  constructor(
    readonly code: 'budget' | 'busy' | 'killed' | 'locked' | 'invalid' | 'unavailable' | 'not_found' | 'denied' | 'stale' | 'stage' | 'missing',
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429 | 503 = 429,
  ) {
    super(message);
  }
}

export const isServiceError = (e: unknown): e is ServiceError => e instanceof ServiceError;
