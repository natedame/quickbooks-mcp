// Promisify helper for node-quickbooks callbacks

export function promisify<T>(fn: (callback: (err: Error | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// QuickBooks throttles per realm — both a request rate and a ceiling on how many
// requests may be in flight at once — and answers 429 when either is exceeded.
const THROTTLE_MAX_ATTEMPTS = 5;
const THROTTLE_BASE_DELAY_MS = 400;

function isThrottleError(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (status === 429 || status === 503) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /\b(429|503)\b/.test(message) || /too many requests/i.test(message);
}

/**
 * Retry a READ-ONLY QuickBooks call through a throttle response.
 *
 * Read-only on purpose: a 429 means the request was rejected rather than
 * processed, but replaying a write is not a risk worth taking on accounting data.
 * That is why this is a separate wrapper rather than something baked into
 * promisify, which every create and update call also goes through.
 */
export async function withThrottleRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= THROTTLE_MAX_ATTEMPTS || !isThrottleError(err)) throw err;
      // Exponential backoff with jitter so parallel callers do not retry in lockstep.
      const delay = THROTTLE_BASE_DELAY_MS * 2 ** (i - 1) * (1 + Math.random());
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * promisify for a read. Identical to promisify, but rides out a throttle rather
 * than surfacing it — which for a query or report handler is the difference
 * between a correct answer and a partial one. Never use this for a write.
 */
export function promisifyRead<T>(fn: (callback: (err: Error | null, result: T) => void) => void): Promise<T> {
  return withThrottleRetry(() => promisify(fn));
}
