export const UP_STATUS_ID = 1;

export const STATUS_NAMES = {
  0: 'Never Connected',
  1: 'Connected',
  2: 'Disconnected',
  3: 'Abandoned',
  4: 'Written Off',
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export class ParseError extends Error {
  constructor(url, reason) {
    super(`could not parse probe payload from ${url}: ${reason}`);
    this.name = 'ParseError';
    this.url = url;
  }
}

export function probeUrl(id, baseUrl = 'https://atlas.ripe.net') {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/v2/probes/${encodeURIComponent(id)}`;
}

function retryAfterMs(response, now) {
  const header = response.headers?.get?.('retry-after');
  if (!header) return null;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);

  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - now());

  return null;
}

/**
 * GETs a URL, retrying transient failures and retryable status codes with
 * exponential backoff. Non-retryable status codes (4xx other than the ones
 * above) fail immediately.
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    attempts = 3,
    backoffMs = 500,
    maxDelayMs = 30_000,
    timeoutMs = 10_000,
    fetchImpl = globalThis.fetch,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    headers = { accept: 'application/json' },
  } = options;

  if (attempts < 1) throw new RangeError('attempts must be >= 1');

  let lastError = new Error(`no attempt was made for ${url}`);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let delay = backoffMs * 2 ** (attempt - 1);

    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      const response = await fetchImpl(url, { headers, signal });

      if (response.ok) return response;

      lastError = new HttpError(response.status, url);
      const retryable = RETRYABLE_STATUS.has(response.status);
      if (attempt >= attempts || !retryable) throw lastError;
      delay = retryAfterMs(response, now) ?? delay;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= attempts) throw lastError;
    }

    await sleepImpl(Math.min(delay, maxDelayMs));
  }

  throw lastError;
}

function optionalNumber(value) {
  return Number.isFinite(value) ? value : null;
}

export function normalizeProbe(body, url = 'probe payload') {
  if (!body || typeof body !== 'object') {
    throw new ParseError(url, 'response body was not an object');
  }
  if (!body.status || typeof body.status !== 'object') {
    throw new ParseError(url, 'response body had no status object');
  }

  const statusId = Number(body.status.id);
  if (!Number.isInteger(statusId)) {
    throw new ParseError(url, 'status.id was not an integer');
  }

  return {
    id: Number.isInteger(body.id) ? body.id : null,
    statusId,
    statusName: String(body.status.name ?? STATUS_NAMES[statusId] ?? 'Unknown'),
    statusSince: optionalNumber(body.status_since),
    totalUptimeSeconds: Math.max(0, optionalNumber(body.total_uptime) ?? 0),
    firstConnected: optionalNumber(body.first_connected),
    lastConnected: optionalNumber(body.last_connected),
    description: body.description ?? null,
    addressV4: body.address_v4 ?? null,
    addressV6: body.address_v6 ?? null,
    asnV4: optionalNumber(body.asn_v4),
    asnV6: optionalNumber(body.asn_v6),
    countryCode: body.country_code ?? null,
    isUp: statusId === UP_STATUS_ID,
  };
}

export async function fetchProbe(id, options = {}) {
  const url = probeUrl(id, options.baseUrl);
  const response = await fetchWithRetry(url, options);

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new ParseError(url, error?.message ?? 'invalid JSON');
  }

  return normalizeProbe(body, url);
}
