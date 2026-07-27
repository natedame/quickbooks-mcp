// Pagination utilities for QuickBooks queries

import QuickBooks from "node-quickbooks";
import { PaginationParams, PaginatedQueryResult, QBQueryResponse } from "../types/index.js";
import { promisify } from "../client/promisify.js";
import { isHttpMode } from "../utils/output.js";

// Pagination constants
export const BATCH_SIZE = 1000;
export const SAFETY_LIMIT = 10000;
export const WARNING_THRESHOLD = 5000;

// Entity type for paginated results
interface PaginatedEntity {
  Id?: string;
  [key: string]: unknown;
}

// Helper to extract entities from QB query response
function extractEntitiesFromResponse(result: unknown): { entityKey: string; entities: PaginatedEntity[] } {
  const response = result as QBQueryResponse<PaginatedEntity> | undefined;
  const queryResponse = response?.QueryResponse;
  if (!queryResponse) {
    return { entityKey: 'Unknown', entities: [] };
  }

  const entityKey = Object.keys(queryResponse).find(k => Array.isArray(queryResponse[k]));
  if (!entityKey) {
    return { entityKey: 'Unknown', entities: [] };
  }

  return { entityKey, entities: queryResponse[entityKey] ?? [] };
}

// Parse pagination params from query string
export function parsePaginationFromQuery(query: string): PaginationParams {
  let maxResults = isHttpMode() ? 100 : 1000; // Lower default for HTTP (results go into context)
  let startPosition: number | null = null;

  // Extract MAXRESULTS
  const maxMatch = query.match(/MAXRESULTS\s+(\d+)/i);
  if (maxMatch) {
    maxResults = parseInt(maxMatch[1], 10);
  }

  // Extract STARTPOSITION (presence disables auto-pagination)
  const startMatch = query.match(/STARTPOSITION\s+(\d+)/i);
  if (startMatch) {
    startPosition = parseInt(startMatch[1], 10);
  }

  // Extract criteria (everything after FROM Entity) and strip pagination clauses
  const criteriaMatch = query.match(/FROM\s+\w+\s*(.*)/i);
  let baseCriteria = criteriaMatch ? criteriaMatch[1].trim() : '';

  // Strip pagination clauses from criteria
  baseCriteria = baseCriteria
    .replace(/\s*MAXRESULTS\s+\d+/gi, '')
    .replace(/\s*STARTPOSITION\s+\d+/gi, '')
    .trim()
    .replace(/;?\s*$/, '');

  return { maxResults, startPosition, baseCriteria };
}

// QuickBooks throttles per realm (both a request rate and a concurrency ceiling)
// and answers 429 when either is exceeded. A throttled query used to surface as an
// error the caller turned into "no transactions", so retrying here — at the single
// point every query passes through — is what keeps a busy account from silently
// reporting incomplete figures.
const THROTTLE_MAX_ATTEMPTS = 5;
const THROTTLE_BASE_DELAY_MS = 400;

function isThrottleError(err: unknown): boolean {
  const status = (err as { response?: { status?: number }; statusCode?: number })?.response?.status
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
 * Run tasks with a ceiling on how many are in flight at once.
 *
 * QuickBooks rejects bursts of concurrent requests per realm, so callers that fan
 * out over many entity types need to stay under that ceiling rather than firing
 * everything at once. Results come back in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// Paginated query fetcher
export async function paginatedQuery(
  client: QuickBooks,
  finderMethod: keyof QuickBooks,
  pagination: PaginationParams
): Promise<PaginatedQueryResult> {
  const { maxResults, startPosition, baseCriteria } = pagination;

  // Build criteria with optional base (WHERE clause, etc.)
  const buildCriteria = (start: number, limit: number) => {
    const parts = [];
    if (baseCriteria) parts.push(baseCriteria);
    parts.push(`STARTPOSITION ${start}`);
    parts.push(`MAXRESULTS ${limit}`);
    return parts.join(' ');
  };

  // Type-safe wrapper to call the finder method (must bind to client to preserve 'this' context)
  const callFinder = (criteria: string): Promise<unknown> => {
    const method = client[finderMethod] as (criteria: string, cb: (err: Error | null, result: unknown) => void) => void;
    return withThrottleRetry(() => promisify<unknown>((cb) => method.call(client, criteria, cb)));
  };

  // If STARTPOSITION is specified, user wants explicit control - single fetch, no auto-pagination
  if (startPosition !== null) {
    const fetchLimit = Math.min(maxResults, BATCH_SIZE);
    const criteria = buildCriteria(startPosition, fetchLimit);
    const result = await callFinder(criteria);
    const { entityKey, entities } = extractEntitiesFromResponse(result);

    // Probe for more data if we got exactly what we requested
    let hasMore = false;
    let apiCalls = 1;
    if (entities.length >= fetchLimit) {
      const probePosition = startPosition + entities.length;
      const probeCriteria = buildCriteria(probePosition, 1);
      const probeResult = await callFinder(probeCriteria);
      apiCalls++;
      const probeEntities = extractEntitiesFromResponse(probeResult).entities;
      hasMore = probeEntities.length > 0;
    }

    return {
      entities,
      entityKey,
      apiCalls,
      truncated: false,
      startPositionSpecified: true,
      hasMore,
      returnedCount: entities.length,
      requestedLimit: fetchLimit
    };
  }

  // Auto-pagination mode
  const allEntities: PaginatedEntity[] = [];
  let apiCalls = 0;
  let currentPosition = 1; // QB uses 1-based indexing
  let entityKey = 'Unknown';
  const targetLimit = Math.min(maxResults, SAFETY_LIMIT);
  let truncated = false;

  while (allEntities.length < targetLimit) {
    const remaining = targetLimit - allEntities.length;
    const batchSize = Math.min(BATCH_SIZE, remaining);

    const criteria = buildCriteria(currentPosition, batchSize);
    const result = await callFinder(criteria);
    apiCalls++;

    const extracted = extractEntitiesFromResponse(result);
    if (extracted.entityKey !== 'Unknown') entityKey = extracted.entityKey;
    const batchEntities = extracted.entities;

    if (batchEntities.length === 0) {
      // No more results
      break;
    }

    allEntities.push(...batchEntities);
    currentPosition += batchEntities.length;

    // If we got fewer than requested, there are no more results
    if (batchEntities.length < batchSize) {
      break;
    }

    // Safety check: if we've hit the safety limit, stop
    if (allEntities.length >= SAFETY_LIMIT) {
      truncated = true;
      break;
    }
  }

  // Check if we hit the safety limit while more data might exist
  if (maxResults > SAFETY_LIMIT && allEntities.length >= SAFETY_LIMIT) {
    truncated = true;
  }

  // Probe for more data if we got exactly what we requested (and not truncated by safety limit)
  let hasMore = truncated; // If truncated, we know there's more
  if (!truncated && allEntities.length >= targetLimit && allEntities.length < SAFETY_LIMIT) {
    const probeCriteria = buildCriteria(currentPosition, 1);
    const probeResult = await callFinder(probeCriteria);
    apiCalls++;
    const probeEntities = extractEntitiesFromResponse(probeResult).entities;
    hasMore = probeEntities.length > 0;
  }

  return {
    entities: allEntities,
    entityKey,
    apiCalls,
    truncated,
    startPositionSpecified: false,
    hasMore,
    returnedCount: allEntities.length,
    requestedLimit: targetLimit
  };
}
