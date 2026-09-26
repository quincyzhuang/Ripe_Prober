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
  pushHistory,
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

test('saveMany uses the { key, value } bulk-put shape, not tuples', async () => {
  const putCalls = [];
  const recorder = {
    get: async () => null,
    put: async (...args) => putCalls.push(args),
  };

  const state = applyObservation(defaultState(T0), up(T0)).state;
  await new KvStore(recorder).saveMany(new Map([[55311, { state, history: [] }]]));

  assert.equal(putCalls.length, 1);
  const [entries] = putCalls[0];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, 'probe:55311');
  assert.equal(typeof entries[0].value, 'string');
  assert.equal(JSON.parse(entries[0].value).state.lastKey, 'status:1');
});

test('MemoryKv rejects the tuple form the real binding also rejects', async () => {
  const kv = new MemoryKv();
  await assert.rejects(kv.put([['probe:1', '{}']]), /not of type 'string or Object'/);
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
