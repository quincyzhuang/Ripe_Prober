const DEFAULT_PROBE_IDS = '55311';
const DEFAULT_BASE_URL = 'https://atlas.ripe.net';
const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

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

  const ntfyTopic = String(env.NTFY_TOPIC ?? '').trim();

  return {
    probeIds,
    baseUrl: stripTrailingSlash(env.ATLAS_BASE_URL || DEFAULT_BASE_URL),
    ntfy: {
      server: stripTrailingSlash(env.NTFY_SERVER || DEFAULT_NTFY_SERVER),
      topic: ntfyTopic,
      enabled: ntfyTopic.length > 0,
    },
    request: {
      attempts: Math.max(1, toInt(env.REQUEST_ATTEMPTS, 3)),
      backoffMs: Math.max(0, toInt(env.RETRY_BACKOFF_MS, 500)),
      timeoutMs: Math.max(1000, toInt(env.REQUEST_TIMEOUT_MS, 10_000)),
      maxDelayMs: Math.max(0, toInt(env.MAX_RETRY_DELAY_MS, 30_000)),
    },
    alerting: {
      enabled: ntfyTopic.length > 0,
      alertOnFirstRun: toBool(env.ALERT_ON_FIRST_RUN, false),
      recoveryAlert: toBool(env.RECOVERY_ALERT, true),
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
