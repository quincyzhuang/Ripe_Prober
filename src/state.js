/**
 * State accounting for one or more probes. Every function here is pure: KV is
 * only read and written at the edges (see KvStore below), which keeps the
 * interesting logic unit-testable without a Workers runtime.
 */

export const UNREACHABLE_KEY = 'unreachable';

export function observationKey(statusId, reachable) {
  return reachable ? `status:${statusId}` : UNREACHABLE_KEY;
}

export function defaultState(checkedAt) {
  return {
    lastCheckedAt: checkedAt,
    lastKey: null,
    lastStatusId: null,
    lastStatusName: null,
    lastStatusSince: null,
    lastAlertedKey: null,
    lastAlertedAt: null,
    pendingAlertKey: null,
    pendingAlertAttempts: 0,
    pendingAlertNotBefore: 0,
    totalUptimeSeconds: 0,
    observedUpSeconds: 0,
    observedDownSeconds: 0,
    observedUnknownSeconds: 0,
    lastError: null,
  };
}

export function defaultRecord() {
  return { state: defaultState(0), history: [] };
}

/**
 * Folds one observation into the previous state.
 *
 * Time between two checks is attributed to whichever condition was observed at
 * the end of the interval. Anything longer than maxSampleSeconds (e.g. the
 * worker was not running for a day) is recorded as unknown rather than
 * silently inflating uptime.
 */
export function applyObservation(previousState, observation, options = {}) {
  const { maxSampleSeconds = 6 * 3600 } = options;
  const previous = previousState ?? defaultState(observation.checkedAt);
  const state = { ...defaultState(observation.checkedAt), ...previous };

  const key = observationKey(observation.statusId ?? null, observation.reachable);

  if (Number.isFinite(previous.lastCheckedAt) && previous.lastKey !== null) {
    const rawElapsed = Math.max(0, observation.checkedAt - previous.lastCheckedAt);
    const accounted = Math.min(rawElapsed, maxSampleSeconds);
    const unaccounted = rawElapsed - accounted;

    if (!observation.reachable) {
      state.observedUnknownSeconds += accounted + unaccounted;
    } else if (observation.up) {
      state.observedUpSeconds += accounted;
      state.observedUnknownSeconds += unaccounted;
    } else {
      state.observedDownSeconds += accounted;
      state.observedUnknownSeconds += unaccounted;
    }
  }

  state.lastCheckedAt = observation.checkedAt;
  state.lastKey = key;
  state.lastStatusId = observation.reachable ? (observation.statusId ?? null) : null;
  state.lastStatusName = observation.reachable ? (observation.statusName ?? null) : UNREACHABLE_KEY;
  state.lastStatusSince = observation.reachable ? (observation.statusSince ?? null) : null;
  state.totalUptimeSeconds = Number.isFinite(observation.totalUptimeSeconds)
    ? observation.totalUptimeSeconds
    : state.totalUptimeSeconds;
  state.lastError = observation.reachable ? null : (observation.error ?? 'unreachable');

  const isInitial = previous.lastKey === null;
  const changed = !isInitial && previous.lastKey !== key;

  return { state, previous, key, isInitial, changed };
}

/**
 * Alerts fire on transitions only, so a three-day outage produces one push
 * instead of 72. The first observation is treated as baseline unless
 * alertOnFirstRun is set.
 *
 * `pending` re-arms an alert whose delivery already failed. Without it a
 * transient delivery error silently swallows the notification: the observation key
 * has advanced, so the next check reports `changed: false` and the transition
 * is never re-evaluated.
 */
export function shouldAlert({ isInitial, changed, alerting, pending = false }) {
  if (!alerting.enabled) return false;
  if (changed) return true;
  if (pending) return true;
  if (isInitial && alerting.alertOnFirstRun) return true;
  return false;
}

/** True when a previous delivery for this same key failed and is due a retry. */
export function pendingAlert(previousState, key, options = {}) {
  const { nowSeconds = 0 } = options;
  const state = previousState ?? defaultState(nowSeconds);
  if (state.pendingAlertKey !== key) return false;
  return nowSeconds >= state.pendingAlertNotBefore;
}

/**
 * Records a failed delivery and schedules the next attempt. The delay doubles
 * per consecutive failure so an undeliverable alert cannot be retried on every
 * cron tick forever. A different key restarts the backoff.
 */
export function recordAlertFailure(previousState, key, checkedAt, options = {}) {
  const { baseSeconds = 1800, maxSeconds = 6 * 3600 } = options;
  const state = previousState ?? defaultState(checkedAt);
  const attempts = state.pendingAlertKey === key ? (state.pendingAlertAttempts ?? 0) + 1 : 1;

  return {
    ...state,
    pendingAlertKey: key,
    pendingAlertAttempts: attempts,
    pendingAlertNotBefore: checkedAt + Math.min(baseSeconds * 2 ** (attempts - 1), maxSeconds),
  };
}

/** Marks the key as delivered, clearing any outstanding retry. */
export function recordAlertDelivered(previousState, key, checkedAt) {
  const state = previousState ?? defaultState(checkedAt);

  return {
    ...state,
    lastAlertedKey: key,
    lastAlertedAt: checkedAt,
    pendingAlertKey: null,
    pendingAlertAttempts: 0,
    pendingAlertNotBefore: 0,
  };
}

export function isRecovery({ previous, observation }) {
  if (!previous.lastKey) return false;
  const wasDown = previous.lastKey === UNREACHABLE_KEY || previous.lastKey !== `status:1`;
  const isUp = observation.reachable && observation.up === true;
  return wasDown && isUp;
}

export function pushHistory(history, observation, options = {}) {
  const { limit = 720 } = options;
  const next = [
    ...(Array.isArray(history) ? history : []),
    {
      t: observation.checkedAt,
      k: observation.reachable ? observation.statusId : null,
      up: Boolean(observation.reachable && observation.up),
    },
  ];
  return next.slice(Math.max(0, next.length - Math.max(1, limit)));
}

export function observedTotals(state) {
  const up = Math.max(0, state.observedUpSeconds ?? 0);
  const down = Math.max(0, state.observedDownSeconds ?? 0);
  const unknown = Math.max(0, state.observedUnknownSeconds ?? 0);
  const total = up + down + unknown;
  return { up, down, unknown, total, percent: total > 0 ? (up / total) * 100 : null };
}

/** Uptime over a trailing window, derived from the per-check history. */
export function windowUptime(history, options = {}) {
  const { nowSeconds, windowSeconds = 86_400 } = options;
  const entries = (Array.isArray(history) ? history : []).filter(
    (entry) => Number.isFinite(entry?.t) && entry.t <= nowSeconds && entry.t > nowSeconds - windowSeconds,
  );

  if (entries.length === 0) {
    return { checks: 0, up: 0, down: 0, unknown: 0, percent: null };
  }

  let up = 0;
  let down = 0;
  let unknown = 0;

  for (const entry of entries) {
    if (entry.k === null) unknown += 1;
    else if (entry.up) up += 1;
    else down += 1;
  }

  const known = up + down;
  return {
    checks: entries.length,
    up,
    down,
    unknown,
    percent: known > 0 ? (up / known) * 100 : null,
  };
}

export function kvKey(probeId) {
  return `probe:${probeId}`;
}

/** Minimal subset of the Workers KV API used here, so tests can fake it. */
export class KvStore {
  constructor(kv) {
    this.kv = kv;
  }

  async loadMany(probeIds) {
    const keys = probeIds.map(kvKey);
    const raw = await this.kv.get(keys);
    const map = raw instanceof Map ? raw : new Map(keys.map((key) => [key, raw?.[key]]));

    const records = new Map();
    for (const id of probeIds) {
      const value = map.get(kvKey(id));
      records.set(id, parseRecord(value));
    }
    return records;
  }

  /**
   * The Workers KV binding exposes only put(key, value, options?). Bulk writes
   * exist in the REST API and in `wrangler kv bulk put`, but not on the
   * binding, so each key is written with its own call.
   */
  async saveMany(records) {
    for (const [id, record] of records) {
      await this.kv.put(kvKey(id), JSON.stringify(record));
    }
  }
}

function parseRecord(value) {
  if (!value) return defaultRecord();
  if (typeof value === 'object') {
    return { state: { ...defaultState(0), ...(value.state ?? {}) }, history: value.history ?? [] };
  }
  try {
    const parsed = JSON.parse(value);
    return {
      state: { ...defaultState(0), ...(parsed.state ?? {}) },
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return defaultRecord();
  }
}
