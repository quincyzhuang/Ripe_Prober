import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryKv } from '../scripts/memory-kv.js';
import { loadConfig } from '../src/config.js';
import { readReport, runCheck } from '../src/check.js';

const HOUR = 3600;
const T0 = 1_790_000_000;

const makeConfig = (overrides = {}) =>
  loadConfig({
    PROBE_IDS: '55311',
    NTFY_TOPIC: 'probe-alerts',
    RETRY_BACKOFF_MS: '0',
    ...overrides,
  });

function atlasPayload(statusId, statusName, totalUptime = 155_228_176) {
  return {
    id: 55311,
    address_v4: '136.62.1.41',
    asn_v4: 16591,
    country_code: 'US',
    description: 'Austin, TX Google Fiber',
    first_connected: 1_593_987_276,
    last_connected: 1_790_392_733,
    status: { id: statusId, name: statusName, since: '2026-09-18T05:01:34Z' },
    status_since: 1_789_707_694,
    total_uptime: totalUptime,
  };
}

function harness({ config = makeConfig() } = {}) {
  const kv = new MemoryKv();
  const publishes = [];
  const state = { statusId: 1, statusName: 'Connected', atlasFails: false, atlasStatus: 200 };

  const fetchImpl = async (url, init) => {
    if (String(url).includes('atlas.ripe.net')) {
      if (state.atlasFails) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(atlasPayload(state.statusId, state.statusName)), {
        status: state.atlasStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    publishes.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  };

  const run = (offsetHours = 0) =>
    runCheck({ config, kv, fetchImpl, now: () => (T0 + offsetHours * HOUR) * 1000 });

  const set = (patch) => Object.assign(state, patch);

  return { kv, publishes, run, set, config };
}

test('the first run seeds state and stays quiet', async () => {
  const { run, publishes } = harness();
  const result = await run(0);

  assert.equal(result.probes.length, 1);
  assert.equal(result.probes[0].isInitial, true);
  assert.equal(result.probes[0].changed, false);
  assert.equal(result.probes[0].alerted, false);
  assert.equal(result.probes[0].up, true);
  assert.equal(result.probes[0].totalUptimeSeconds, 155_228_176);
  assert.deepEqual(publishes, []);
});

test('alertOnFirstRun reports a probe that is already down at deploy time', async () => {
  const { run, publishes, set } = harness({ config: makeConfig({ ALERT_ON_FIRST_RUN: 'true' }) });

  set({ statusId: 2, statusName: 'Disconnected' });
  const initial = await run(0);
  assert.equal(initial.probes[0].alerted, true);
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].title, 'Atlas 55311 DOWN');
  assert.equal(publishes[0].priority, 3);
});

test('a healthy first run is baseline, not an alert', async () => {
  const { run, publishes } = harness({ config: makeConfig({ ALERT_ON_FIRST_RUN: 'true' }) });

  const initial = await run(0);
  assert.equal(initial.probes[0].isInitial, true);
  assert.equal(initial.probes[0].alerted, false);
  assert.equal(initial.probes[0].suppressed, true);
  assert.deepEqual(publishes, []);

  await run(1);
  assert.deepEqual(publishes, []);
});

test('exactly one push per transition, none for a steady state', async () => {
  const { run, publishes, set } = harness();

  await run(0);
  await run(1);
  assert.equal(publishes.length, 0);

  set({ statusId: 2, statusName: 'Disconnected' });
  const wentDown = await run(2);
  assert.equal(wentDown.probes[0].changed, true);
  assert.equal(wentDown.probes[0].alerted, true);
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].title, 'Atlas 55311 DOWN');
  assert.equal(publishes[0].priority, 3);

  const stillDown = await run(3);
  assert.equal(stillDown.probes[0].changed, false);
  assert.equal(stillDown.probes[0].alerted, false);
  assert.equal(publishes.length, 1);

  set({ statusId: 1, statusName: 'Connected' });
  const recovered = await run(4);
  assert.equal(recovered.probes[0].recovery, true);
  assert.equal(recovered.probes[0].alerted, true);
  assert.equal(publishes.length, 2);
  assert.equal(publishes[1].title, 'Atlas 55311 RECOVERED');
  assert.match(publishes[1].message, /Previous: Disconnected/);

  const stillUp = await run(5);
  assert.equal(stillUp.probes[0].alerted, false);
  assert.equal(publishes.length, 2);
});

test('RECOVERY_ALERT=false keeps the down alert but drops the all-clear', async () => {
  const { run, publishes, set } = harness({ config: makeConfig({ RECOVERY_ALERT: 'false' }) });

  await run(0);
  set({ statusId: 2, statusName: 'Disconnected' });
  await run(1);
  assert.equal(publishes.length, 1);

  set({ statusId: 1, statusName: 'Connected' });
  const recovered = await run(2);
  assert.equal(recovered.probes[0].changed, true);
  assert.equal(recovered.probes[0].alerted, false);
  assert.equal(recovered.probes[0].suppressed, true);
  assert.equal(publishes.length, 1);
});

test('a persistent HTTP failure is reported as unreachable after retries', async () => {
  const { run, publishes, set } = harness({ config: makeConfig({ REQUEST_ATTEMPTS: '2' }) });

  await run(0);
  set({ atlasStatus: 503 });
  const broken = await run(1);

  assert.equal(broken.probes[0].reachable, false);
  assert.equal(broken.probes[0].up, false);
  assert.equal(broken.probes[0].status.name, 'unreachable');
  assert.equal(broken.probes[0].alerted, true);
  assert.equal(publishes.length, 1);
  assert.match(publishes[0].message, /Atlas API unreachable after 2 attempt\(s\): HTTP 503/);

  set({ atlasStatus: 200 });
  const back = await run(2);
  assert.equal(back.probes[0].up, true);
  assert.equal(back.probes[0].recovery, true);
  assert.equal(publishes.length, 2);
});

test('a failing ntfy does not stop the state from being recorded', async () => {
  const kv = new MemoryKv();
  const config = makeConfig();
  let probeStatus = 1;
  let ntfyShouldFail = false;

  const fetchImpl = async (url, init) => {
    if (String(url).includes('atlas.ripe.net')) {
      return new Response(JSON.stringify(atlasPayload(probeStatus, probeStatus === 1 ? 'Connected' : 'Disconnected')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (ntfyShouldFail) return new Response('too big', { status: 413 });
    return new Response('ok', { status: 200 });
  };

  const now = (hours) => () => (T0 + hours * HOUR) * 1000;

  await runCheck({ config, kv, fetchImpl, now: now(0) });
  probeStatus = 2;
  ntfyShouldFail = true;
  const result = await runCheck({ config, kv, fetchImpl, now: now(1) });

  assert.equal(result.probes[0].changed, true);
  assert.equal(result.probes[0].alerted, false);
  assert.equal(result.probes[0].suppressed, true);

  const stored = JSON.parse((await kv.get('probe:55311')));
  assert.equal(stored.state.lastKey, 'status:2');
  assert.equal(stored.history.length, 2);
});

test('multiple probes are tracked independently', async () => {
  const kv = new MemoryKv();
  const config = makeConfig({ PROBE_IDS: '55311, 55312' });
  const publishes = [];
  const statuses = new Map([
    [55311, 1],
    [55312, 2],
  ]);

  const fetchImpl = async (url, init) => {
    if (String(url).includes('atlas.ripe.net')) {
      const id = Number(url.split('/').pop());
      const statusId = statuses.get(id);
      const body = atlasPayload(statusId, statusId === 1 ? 'Connected' : 'Disconnected');
      return new Response(JSON.stringify({ ...body, id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    publishes.push(JSON.parse(init.body));
    return new Response('ok', { status: 200 });
  };

  const result = await runCheck({ config, kv, fetchImpl, now: () => T0 * 1000 });
  assert.deepEqual(result.probes.map((probe) => probe.id), [55311, 55312]);
  assert.equal(result.probes[0].up, true);
  assert.equal(result.probes[1].up, false);
  assert.equal(publishes.length, 0);

  // 55311 goes down, 55312 stays down: only 55311 should alert.
  statuses.set(55311, 2);
  const next = await runCheck({ config, kv, fetchImpl, now: () => (T0 + HOUR) * 1000 });

  assert.deepEqual(next.probes.filter((probe) => probe.changed).map((probe) => probe.id), [55311]);
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].title, 'Atlas 55311 DOWN');

  assert.equal(JSON.parse(await kv.get('probe:55311')).state.lastKey, 'status:2');
  assert.equal(JSON.parse(await kv.get('probe:55312')).state.lastKey, 'status:2');
});

test('readReport reflects the last stored check without calling the API', async () => {
  const { run, kv, config } = harness();
  await run(0);
  await run(1);

  const report = await readReport({ config, kv, now: () => (T0 + HOUR) * 1000 });
  assert.equal(report.probes[0].id, 55311);
  assert.equal(report.probes[0].up, true);
  assert.equal(report.probes[0].status.name, 'Connected');
  assert.equal(report.probes[0].totalUptimeSeconds, 155_228_176);
  assert.equal(report.probes[0].observed.up, HOUR);
  assert.equal(report.probes[0].window.checks, 2);
});
