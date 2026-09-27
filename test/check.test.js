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
    RESEND_API_KEY: 're_test_key',
    ALERT_EMAIL_TO: 'ops@example.com',
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
  assert.match(publishes[0].subject, /\[DOWN\]/);
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
  assert.match(publishes[0].subject, /\[DOWN\]/);

  const stillDown = await run(3);
  assert.equal(stillDown.probes[0].changed, false);
  assert.equal(stillDown.probes[0].alerted, false);
  assert.equal(publishes.length, 1);

  set({ statusId: 1, statusName: 'Connected' });
  const recovered = await run(4);
  assert.equal(recovered.probes[0].recovery, true);
  assert.equal(recovered.probes[0].alerted, true);
  assert.equal(publishes.length, 2);
  assert.match(publishes[1].subject, /\[RECOVERED\]/);
  assert.match(publishes[1].text, /Previous: Disconnected/);

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
  assert.match(publishes[0].text, /Atlas API unreachable after 2 attempt\(s\): HTTP 503/);

  set({ atlasStatus: 200 });
  const back = await run(2);
  assert.equal(back.probes[0].up, true);
  assert.equal(back.probes[0].recovery, true);
  assert.equal(publishes.length, 2);
});

test('a failing email does not stop the state from being recorded', async () => {
  const kv = new MemoryKv();
  const config = makeConfig();
  let probeStatus = 1;
  let emailShouldFail = false;

  const fetchImpl = async (url, init) => {
    if (String(url).includes('atlas.ripe.net')) {
      return new Response(JSON.stringify(atlasPayload(probeStatus, probeStatus === 1 ? 'Connected' : 'Disconnected')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (emailShouldFail) return new Response('ValidationError: from address is invalid', { status: 422 });
    return new Response('ok', { status: 200 });
  };

  const now = (hours) => () => (T0 + hours * HOUR) * 1000;

  await runCheck({ config, kv, fetchImpl, now: now(0) });
  probeStatus = 2;
  emailShouldFail = true;
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
  assert.match(publishes[0].subject, /\[DOWN\]/);

  assert.equal(JSON.parse(await kv.get('probe:55311')).state.lastKey, 'status:2');
  assert.equal(JSON.parse(await kv.get('probe:55312')).state.lastKey, 'status:2');
});

test('a transition lost to a failed publish is retried on a later run', async () => {
  const kv = new MemoryKv();
  const config = makeConfig();
  let probeStatus = 1;
  let emailStatus = 200;
  const publishes = [];

  const fetchImpl = async (url, init) => {
    if (String(url).includes('atlas.ripe.net')) {
      const body = atlasPayload(probeStatus, probeStatus === 1 ? 'Connected' : 'Disconnected');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    publishes.push(JSON.parse(init.body));
    return new Response(emailStatus === 200 ? '{"id":"msg_1"}' : 'rate limited', { status: emailStatus });
  };

  const now = (hours) => () => (T0 + hours * HOUR) * 1000;

  await runCheck({ config, kv, fetchImpl, now: now(0) });

  // The disconnect happens on a run where the provider is rate limiting us.
  probeStatus = 2;
  emailStatus = 429;
  const lost = await runCheck({ config, kv, fetchImpl, now: now(1) });

  assert.equal(lost.probes[0].changed, true);
  assert.equal(lost.probes[0].alerted, false);
  assert.equal(lost.probes[0].suppressed, true);
  assert.equal(lost.probes[0].pendingAlert, 'status:2');
  // One attempt per run: the push is not retried in-run.
  assert.equal(publishes.length, 1);

  // The state has already advanced, so the next tick reports no transition.
  // This is the case that used to drop the alert permanently.
  emailStatus = 200;
  const retry = await runCheck({ config, kv, fetchImpl, now: now(2) });

  assert.equal(retry.probes[0].changed, false);
  assert.equal(retry.probes[0].retrying, true);
  assert.equal(retry.probes[0].alerted, true);
  assert.equal(retry.probes[0].pendingAlert, null);
  assert.equal(publishes.length, 2);
  assert.match(publishes[1].subject, /\[DOWN\]/);

  // Delivered, so it goes quiet again.
  const quiet = await runCheck({ config, kv, fetchImpl, now: now(3) });
  assert.equal(quiet.probes[0].alerted, false);
  assert.equal(quiet.probes[0].retrying, false);
  assert.equal(publishes.length, 2);

  // The recovery still alerts normally afterwards.
  probeStatus = 1;
  const recovered = await runCheck({ config, kv, fetchImpl, now: now(4) });
  assert.equal(recovered.probes[0].recovery, true);
  assert.equal(publishes.length, 3);
  assert.match(publishes[2].subject, /\[RECOVERED\]/);
});

test('a pending alert waits out its backoff instead of retrying every tick', async () => {
  const kv = new MemoryKv();
  const config = makeConfig();
  let probeStatus = 1;
  let emailStatus = 200;
  let attempts = 0;

  const fetchImpl = async (url) => {
    if (String(url).includes('atlas.ripe.net')) {
      const body = atlasPayload(probeStatus, probeStatus === 1 ? 'Connected' : 'Disconnected');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    attempts += 1;
    return new Response(emailStatus === 200 ? '{"id":"msg_1"}' : 'rate limited', { status: emailStatus });
  };

  const at = (seconds) => () => (T0 + seconds) * 1000;

  await runCheck({ config, kv, fetchImpl, now: at(0) });

  probeStatus = 2;
  emailStatus = 429;
  await runCheck({ config, kv, fetchImpl, now: at(1800) });
  assert.equal(attempts, 1);

  // First failure backs off 1800s, so a tick 15 minutes later stays quiet.
  const tooSoon = await runCheck({ config, kv, fetchImpl, now: at(1800 + 900) });
  assert.equal(tooSoon.probes[0].retrying, false);
  assert.equal(tooSoon.probes[0].alerted, false);
  assert.equal(attempts, 1);

  emailStatus = 200;
  const dueRetry = await runCheck({ config, kv, fetchImpl, now: at(1800 + 1800) });
  assert.equal(dueRetry.probes[0].retrying, true);
  assert.equal(dueRetry.probes[0].alerted, true);
  assert.equal(attempts, 2);
});

test('a stale pending marker does not resurrect a superseded status', async () => {
  const kv = new MemoryKv();
  const config = makeConfig();
  let probeStatus = 1;
  let emailStatus = 200;

  const fetchImpl = async (url) => {
    if (String(url).includes('atlas.ripe.net')) {
      const body = atlasPayload(probeStatus, probeStatus === 1 ? 'Connected' : 'Disconnected');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(emailStatus === 200 ? '{"id":"msg_1"}' : 'rate limited', { status: emailStatus });
  };

  const now = (hours) => () => (T0 + hours * HOUR) * 1000;

  await runCheck({ config, kv, fetchImpl, now: now(0) });

  // Fails while down, then the probe recovers before the retry is due.
  probeStatus = 2;
  emailStatus = 429;
  await runCheck({ config, kv, fetchImpl, now: now(1) });
  assert.equal(JSON.parse(await kv.get('probe:55311')).state.pendingAlertKey, 'status:2');

  probeStatus = 1;
  emailStatus = 200;
  const recovered = await runCheck({ config, kv, fetchImpl, now: now(2) });

  // The all-clear is sent; the superseded disconnect is not re-sent afterwards.
  assert.equal(recovered.probes[0].recovery, true);
  assert.equal(recovered.probes[0].alerted, true);

  const steady = await runCheck({ config, kv, fetchImpl, now: now(3) });
  assert.equal(steady.probes[0].retrying, false);
  assert.equal(steady.probes[0].alerted, false);
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
