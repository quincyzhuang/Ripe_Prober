import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryKv } from '../scripts/memory-kv.js';
import {
  KvStore,
  UNREACHABLE_KEY,
  applyObservation,
  defaultState,
  isRecovery,
  observedTotals,
  observationKey,
  pendingAlert,
  pushHistory,
  recordAlertDelivered,
  recordAlertFailure,
  shouldAlert,
  windowUptime,
} from '../src/state.js';

const HOUR = 3600;
const T0 = 1_790_000_000;

const up = (checkedAt, extra = {}) => ({
  checkedAt,
  reachable: true,
  up: true,
  statusId: 1,
  statusName: 'Connected',
  statusSince: T0,
  totalUptimeSeconds: 1000,
  error: null,
  ...extra,
});

const down = (checkedAt) => ({
  checkedAt,
  reachable: true,
  up: false,
  statusId: 2,
  statusName: 'Disconnected',
  statusSince: checkedAt,
  totalUptimeSeconds: 1000,
  error: null,
});

const unreachable = (checkedAt) => ({
  checkedAt,
  reachable: false,
  up: false,
  statusId: null,
  statusName: UNREACHABLE_KEY,
  statusSince: null,
  totalUptimeSeconds: null,
  error: 'HTTP 503 for https://atlas.ripe.net/api/v2/probes/55311',
});

const alerting = { enabled: true, alertOnFirstRun: false, recoveryAlert: true };

test('observationKey separates unreachable from status ids', () => {
  assert.equal(observationKey(1, true), 'status:1');
  assert.equal(observationKey(2, true), 'status:2');
  assert.equal(observationKey(null, false), UNREACHABLE_KEY);
});

test('the first observation is baseline, not a transition', () => {
  const { isInitial, changed } = applyObservation(defaultState(T0), down(T0));
  assert.equal(isInitial, true);
  assert.equal(changed, false);
  assert.equal(shouldAlert({ isInitial, changed, alerting }), false);
});

test('alertOnFirstRun overrides the baseline rule', () => {
  const { isInitial, changed } = applyObservation(defaultState(T0), down(T0));
  assert.equal(
    shouldAlert({ isInitial, changed, alerting: { ...alerting, alertOnFirstRun: true } }),
    true,
  );
});

test('alerting can be disabled entirely', () => {
  const { isInitial, changed } = applyObservation(defaultState(T0), down(T0));
  assert.equal(shouldAlert({ isInitial, changed, alerting: { ...alerting, enabled: false } }), false);
});

test('uptime accrues for the interval that ended in each state', () => {
  let state = applyObservation(defaultState(T0), up(T0)).state;
  const second = applyObservation(state, up(T0 + HOUR));
  state = second.state;

  assert.equal(second.changed, false);
  assert.equal(state.observedUpSeconds, HOUR);
  assert.equal(state.observedDownSeconds, 0);

  const third = applyObservation(state, down(T0 + 2 * HOUR));
  assert.equal(third.changed, true);
  assert.equal(shouldAlert({ isInitial: third.isInitial, changed: third.changed, alerting }), true);
  assert.equal(third.state.observedUpSeconds, HOUR);
  assert.equal(third.state.observedDownSeconds, HOUR);

  const fourth = applyObservation(third.state, up(T0 + 3 * HOUR));
  assert.equal(fourth.state.observedUpSeconds, 2 * HOUR);
  assert.equal(fourth.state.observedDownSeconds, HOUR);
  assert.ok(Math.abs(observedTotals(fourth.state).percent - 200 / 3) < 1e-9);
});

test('the interval ending in a failed check counts as downtime, not the one before it', () => {
  let state = applyObservation(defaultState(T0), down(T0)).state;
  state = applyObservation(state, down(T0 + HOUR)).state;
  const third = applyObservation(state, up(T0 + 2 * HOUR));

  assert.equal(third.state.observedDownSeconds, HOUR);
  assert.equal(third.state.observedUpSeconds, HOUR);
});

test('unreachable is tracked as unknown time, not as uptime', () => {
  let state = applyObservation(defaultState(T0), up(T0)).state;
  state = applyObservation(state, up(T0 + HOUR)).state;
  const third = applyObservation(state, unreachable(T0 + 2 * HOUR));

  assert.equal(third.state.lastKey, UNREACHABLE_KEY);
  assert.equal(third.changed, true);
  assert.equal(third.state.observedUpSeconds, HOUR);
  assert.equal(third.state.observedUnknownSeconds, HOUR);
  assert.equal(third.state.lastError.startsWith('HTTP 503'), true);
});

test('long gaps past maxSampleSeconds are recorded as unknown', () => {
  let state = applyObservation(defaultState(T0), up(T0)).state;
  const later = applyObservation(state, up(T0 + 30 * HOUR), { maxSampleSeconds: 6 * HOUR });
  const totals = observedTotals(later.state);

  assert.equal(totals.up, 6 * HOUR);
  assert.equal(totals.unknown, 24 * HOUR);
  assert.equal(totals.total, 30 * HOUR);
});

test('a backwards clock does not subtract uptime', () => {
  const state = applyObservation(defaultState(T0), up(T0 + 10 * HOUR)).state;
  const rewound = applyObservation(state, up(T0 + HOUR));

  assert.equal(rewound.state.observedUpSeconds, 0);
  assert.equal(rewound.state.lastCheckedAt, T0 + HOUR);
});

test('isRecovery only fires for a down to up transition', () => {
  const first = applyObservation(defaultState(T0), up(T0));
  assert.equal(isRecovery({ previous: first.previous, observation: up(T0 + HOUR) }), false);

  const downState = applyObservation(first.state, down(T0 + HOUR));
  assert.equal(isRecovery({ previous: downState.state, observation: up(T0 + 2 * HOUR) }), true);
  assert.equal(isRecovery({ previous: downState.state, observation: down(T0 + 2 * HOUR) }), false);

  const unreachableState = applyObservation(first.state, unreachable(T0 + HOUR));
  assert.equal(isRecovery({ previous: unreachableState.state, observation: up(T0 + 2 * HOUR) }), true);
  assert.equal(isRecovery({ previous: first.state, observation: up(T0 + HOUR) }), false);
});

test('a failed delivery is retried on later runs even though changed is false', () => {
  const first = applyObservation(defaultState(T0), up(T0));
  const second = applyObservation(first.state, down(T0 + HOUR));
  assert.equal(second.changed, true);

  // The publish fails, so lastAlertedKey stays at the old key and the pending
  // marker points at the new one.
  const failed = recordAlertFailure(second.state, second.key, T0 + HOUR);
  assert.equal(failed.lastAlertedKey, null);
  assert.equal(failed.pendingAlertKey, 'status:2');

  // Next check sees the same status, so there is no transition any more.
  const third = applyObservation(failed, down(T0 + 2 * HOUR));
  assert.equal(third.changed, false);
  assert.equal(shouldAlert({ isInitial: false, changed: third.changed, alerting }), false);

  // But the pending marker re-arms it once the backoff has elapsed.
  assert.equal(pendingAlert(failed, third.key, { nowSeconds: T0 + HOUR }), false);
  assert.equal(pendingAlert(failed, third.key, { nowSeconds: T0 + 2 * HOUR }), true);
  assert.equal(shouldAlert({ isInitial: false, changed: false, alerting, pending: true }), true);
});

test('a delivered alert clears the pending marker and stops re-alerting', () => {
  const first = applyObservation(defaultState(T0), up(T0));
  const second = applyObservation(first.state, down(T0 + HOUR));
  const failed = recordAlertFailure(second.state, second.key, T0 + HOUR);
  const delivered = recordAlertDelivered(failed, second.key, T0 + 2 * HOUR);

  assert.equal(delivered.lastAlertedKey, 'status:2');
  assert.equal(delivered.lastAlertedAt, T0 + 2 * HOUR);
  assert.equal(delivered.pendingAlertKey, null);
  assert.equal(pendingAlert(delivered, 'status:2', { nowSeconds: T0 + 99 * HOUR }), false);
});

test('repeated failures back off and reset when the status changes', () => {
  let state = recordAlertFailure(defaultState(T0), 'status:2', T0);
  assert.equal(state.pendingAlertAttempts, 1);
  assert.equal(state.pendingAlertNotBefore, T0 + 1800);

  state = recordAlertFailure(state, 'status:2', T0 + 1800);
  assert.equal(state.pendingAlertAttempts, 2);
  assert.equal(state.pendingAlertNotBefore, T0 + 1800 + 3600);

  // The delay caps at 6h, measured from the check that failed.
  let capped = state;
  for (let i = 0; i < 10; i += 1) capped = recordAlertFailure(capped, 'status:2', T0 + i * HOUR);
  assert.equal(capped.pendingAlertNotBefore - (T0 + 9 * HOUR), 6 * HOUR);

  // A new status is a new situation, so the backoff starts over.
  const fresh = recordAlertFailure(state, 'unreachable', T0 + 1800);
  assert.equal(fresh.pendingAlertAttempts, 1);
  assert.equal(fresh.pendingAlertKey, 'unreachable');
});

test('pendingAlert ignores a marker left over from a different status', () => {
  const failed = recordAlertFailure(defaultState(T0), 'status:2', T0);
  assert.equal(pendingAlert(failed, 'status:1', { nowSeconds: T0 + 99 * HOUR }), false);
  assert.equal(pendingAlert(failed, UNREACHABLE_KEY, { nowSeconds: T0 + 99 * HOUR }), false);
});

test('pushHistory keeps only the newest entries', () => {
  let history = [];
  for (let i = 0; i < 10; i += 1) {
    history = pushHistory(history, up(T0 + i * HOUR), { limit: 4 });
  }

  assert.equal(history.length, 4);
  assert.equal(history[0].t, T0 + 6 * HOUR);
  assert.equal(history[3].t, T0 + 9 * HOUR);
  assert.equal(history[3].up, true);
});

test('windowUptime only counts entries inside the window', () => {
  const history = [
    { t: T0, k: 1, up: true },
    { t: T0 + HOUR, k: 1, up: true },
    { t: T0 + 2 * HOUR, k: 2, up: false },
    { t: T0 + 3 * HOUR, k: null, up: false },
  ];

  const day = windowUptime(history, { nowSeconds: T0 + 4 * HOUR, windowSeconds: 24 * HOUR });
  assert.equal(day.checks, 4);
  assert.equal(day.up, 2);
  assert.equal(day.down, 1);
  assert.equal(day.unknown, 1);
  assert.ok(Math.abs(day.percent - 200 / 3) < 1e-9);

  // The last 3h contain one down check and one unreachable check; neither the
  // oldest entries nor the unknown entry may distort the percentage.
  const hour3 = windowUptime(history, { nowSeconds: T0 + 4 * HOUR, windowSeconds: 3 * HOUR });
  assert.equal(hour3.checks, 2);
  assert.equal(hour3.up, 0);
  assert.equal(hour3.down, 1);
  assert.equal(hour3.unknown, 1);
  assert.equal(hour3.percent, 0);

  const hour2 = windowUptime(history, { nowSeconds: T0 + 4 * HOUR, windowSeconds: 2 * HOUR });
  assert.equal(hour2.checks, 1);
  assert.equal(hour2.percent, null);

  assert.equal(windowUptime([], { nowSeconds: T0 }).percent, null);
});

test('saveMany writes one two-argument put per key, the only form the binding accepts', async () => {
  const putCalls = [];
  const recorder = {
    get: async () => null,
    put: async (...args) => putCalls.push(args),
  };

  const state = applyObservation(defaultState(T0), up(T0)).state;
  await new KvStore(recorder).saveMany(
    new Map([
      [55311, { state, history: [] }],
      [55312, { state, history: [] }],
    ]),
  );

  assert.equal(putCalls.length, 2);
  assert.equal(putCalls[0].length, 2);
  assert.equal(putCalls[0][0], 'probe:55311');
  assert.equal(typeof putCalls[0][1], 'string');
  assert.equal(JSON.parse(putCalls[0][1]).state.lastKey, 'status:1');
  assert.equal(putCalls[1][0], 'probe:55312');
});

test('MemoryKv rejects the bulk-put form the real binding also rejects', async () => {
  const kv = new MemoryKv();
  await assert.rejects(kv.put([{ key: 'probe:1', value: '{}' }]), /bulk writes are not supported/);
  await assert.rejects(kv.put([['probe:1', '{}']]), /bulk writes are not supported/);
  await assert.rejects(kv.put(123, '{}'), /key must be a string/);
  await assert.rejects(kv.put('probe:1', 123), /value must be a string/);
  assert.equal(kv.map.size, 0);
});

test('MemoryKv supports bulk get, which the binding does', async () => {
  const kv = new MemoryKv({ 'probe:55311': '{"a":1}' });
  const many = await kv.get(['probe:55311', 'probe:55312']);
  assert.ok(many instanceof Map);
  assert.equal(many.get('probe:55311'), '{"a":1}');
  assert.equal(many.get('probe:55312'), null);
});

test('KvStore round-trips records and survives corrupt values', async () => {
  const kv = new MemoryKv({ 'probe:55311': '{ not json' });
  const store = new KvStore(kv);

  const loaded = await store.loadMany([55311, 55312]);
  assert.equal(loaded.get(55311).state.lastKey, null);
  assert.equal(loaded.get(55312).state.lastKey, null);

  const state = applyObservation(defaultState(T0), up(T0)).state;
  await store.saveMany(new Map([[55311, { state, history: [{ t: T0, k: 1, up: true }] }]]));

  const reloaded = await new KvStore(kv).loadMany([55311]);
  assert.equal(reloaded.get(55311).state.lastKey, 'status:1');
  assert.equal(reloaded.get(55311).state.totalUptimeSeconds, 1000);
  assert.equal(reloaded.get(55311).history.length, 1);
});
