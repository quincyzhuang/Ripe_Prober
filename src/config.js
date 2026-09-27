const DEFAULT_PROBE_IDS = '55311';
const DEFAULT_BASE_URL = 'https://atlas.ripe.net';
const DEFAULT_RESEND_API_URL = 'https://api.resend.com';
const DEFAULT_EMAIL_FROM = 'RIPE Atlas alerts <onboarding@resend.dev>';

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

export function parseProbeIds(value) {
  const ids = String(value ?? DEFAULT_PROBE_IDS)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  return [...new Set(ids)];
}

export function loadConfig(env = {}) {
  const probeIds = parseProbeIds(env.PROBE_IDS);
  if (probeIds.length === 0) {
    throw new Error('PROBE_IDS must contain at least one numeric probe id');
  }

  const apiKey = String(env.RESEND_API_KEY ?? '').trim();
  const to = String(env.ALERT_EMAIL_TO ?? '').trim();

  // Both halves are required. Reporting this as a single boolean is what let a
  // misspelled secret disable alerting with no error and no log line.
  const emailEnabled = apiKey.length > 0 && to.length > 0;

  return {
    probeIds,
    baseUrl: stripTrailingSlash(env.ATLAS_BASE_URL || DEFAULT_BASE_URL),
    email: {
      apiUrl: `${stripTrailingSlash(env.RESEND_API_URL || DEFAULT_RESEND_API_URL)}/emails`,
      apiKey,
      to,
      from: String(env.ALERT_EMAIL_FROM || DEFAULT_EMAIL_FROM).trim(),
      enabled: emailEnabled,
    },
    request: {
      attempts: Math.max(1, toInt(env.REQUEST_ATTEMPTS, 3)),
      backoffMs: Math.max(0, toInt(env.RETRY_BACKOFF_MS, 500)),
      timeoutMs: Math.max(1000, toInt(env.REQUEST_TIMEOUT_MS, 10_000)),
      maxDelayMs: Math.max(0, toInt(env.MAX_RETRY_DELAY_MS, 30_000)),
    },
    alerting: {
      enabled: emailEnabled,
      alertOnFirstRun: toBool(env.ALERT_ON_FIRST_RUN, false),
      recoveryAlert: toBool(env.RECOVERY_ALERT, true),
      retryBaseSeconds: Math.max(0, toInt(env.ALERT_RETRY_BASE_SECONDS, 1800)),
      retryMaxSeconds: Math.max(0, toInt(env.ALERT_RETRY_MAX_SECONDS, 21_600)),
    },
    history: {
      limit: Math.max(1, toInt(env.HISTORY_LIMIT, 720)),
    },
    uptime: {
      observedWindowSeconds: Math.max(60, toInt(env.OBSERVED_WINDOW_SECONDS, 86_400)),
      maxSampleSeconds: Math.max(60, toInt(env.MAX_SAMPLE_SECONDS, 21_600)),
    },
  };
}
