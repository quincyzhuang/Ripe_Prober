import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, parseProbeIds } from '../src/config.js';
import { buildMessage, notifyNtfy } from '../src/notify.js';

const HOUR = 3600;
const T0 = 1_790_000_000;

const config = loadConfig({ PROBE_IDS: '55311', NTFY_TOPIC: 'probe-alerts' });

const probe = {
  id: 55311,
  statusId: 2,
  statusName: 'Disconnected',
  statusSince: T0,
  totalUptimeSeconds: 155_228_176,
  description: 'Austin, TX Google Fiber',
  addressV4: '136.62.1.41',
  asnV4: 16591,
  countryCode: 'US',
};

const observation = {
  checkedAt: T0 + 2 * HOUR,
  reachable: true,
  up: false,
  statusId: 2,
  statusName: 'Disconnected',
  error: null,
};

const baseArgs = {
  probe,
  observation,
  previous: { lastStatusName: 'Connected' },
  observed: { percent: 99.5 },
  window: { checks: 2, up: 1, down: 1, percent: 50 },
  windowSeconds: 86_400,
  config,
  recovery: false,
};

test('parseProbeIds handles comma lists, blanks and duplicates', () => {
  assert.deepEqual(parseProbeIds('55311, 55312 ,55311'), [55311, 55312]);
  assert.deepEqual(parseProbeIds('not-a-number'), []);
  assert.deepEqual(parseProbeIds(undefined), [55311]);
});

test('loadConfig rejects an empty probe list', () => {
  assert.throws(() => loadConfig({ PROBE_IDS: 'nope' }), /at least one numeric probe id/);
});

test('loadConfig reads booleans and numbers', () => {
  const loaded = loadConfig({
    PROBE_IDS: '1',
    NTFY_TOPIC: 'x',
    REQUEST_ATTEMPTS: '5',
    ALERT_ON_FIRST_RUN: 'true',
    RECOVERY_ALERT: 'no',
  });

  assert.equal(loaded.request.attempts, 5);
  assert.equal(loaded.alerting.alertOnFirstRun, true);
  assert.equal(loaded.alerting.recoveryAlert, false);
  assert.equal(loaded.ntfy.enabled, true);
});

test('a disconnect alert is urgent and names the probe', () => {
  const message = buildMessage(baseArgs);

  assert.equal(message.title, 'Atlas 55311 DOWN');
  assert.equal(message.priority, 3);
  assert.deepEqual(message.tags, ['warning']);
  assert.equal(message.topic, 'probe-alerts');
  assert.match(message.message, /Austin, TX Google Fiber · AS16591 · 136\.62\.1\.41 · US/);
  assert.match(message.message, /Status: Disconnected \(id 2\)/);
  assert.match(message.message, /API total uptime: 1796d 14h 56m/);
  assert.match(message.message, /Observed uptime: 99\.50%/);
  assert.match(message.message, /Uptime last 1d 0h 0m: 50\.00% \(2 checks\)/);
  assert.match(message.message, /^Checked: \d{4}-\d{2}-\d{2}T/m);
});

test('a recovery alert is calmer and mentions the previous status', () => {
  const message = buildMessage({ ...baseArgs, recovery: true, observation: { ...observation, up: true, statusId: 1, statusName: 'Connected' } });

  assert.equal(message.title, 'Atlas 55311 RECOVERED');
  assert.equal(message.priority, 2);
  assert.deepEqual(message.tags, ['white_check_mark']);
  assert.match(message.message, /Previous: Connected/);
});

test('an unreachable API is reported as such', () => {
  const message = buildMessage({
    ...baseArgs,
    probe: { ...probe, statusName: 'unknown', statusId: null, totalUptimeSeconds: 0, statusSince: null },
    observation: { ...observation, reachable: false, error: 'HTTP 503 for https://atlas.ripe.net/api/v2/probes/55311' },
  });

  assert.equal(message.title, 'Atlas 55311 DOWN');
  assert.match(message.message, /Atlas API unreachable after 3 attempt\(s\): HTTP 503/);
});

test('notifyNtfy posts JSON with no-store headers', async () => {
  const calls = [];
  const result = await notifyNtfy(config, { topic: 'probe-alerts', title: 't', message: 'm' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.sh/probe-alerts');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['cache-control'], 'no-store');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { topic: 'probe-alerts', title: 't', message: 'm' });
});

test('notifyNtfy honours a custom server and skips when unconfigured', async () => {
  const custom = loadConfig({ NTFY_TOPIC: 'probe-alerts', NTFY_SERVER: 'https://ntfy.example.com/' });
  const calls = [];
  await notifyNtfy(custom, { topic: 'probe-alerts' }, {
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('ok', { status: 200 });
    },
  });
  assert.deepEqual(calls, ['https://ntfy.example.com/probe-alerts']);

  const unconfigured = loadConfig({ PROBE_IDS: '1' });
  assert.deepEqual(await notifyNtfy(unconfigured, { topic: 'x' }, { fetchImpl: async () => assert.fail('must not send') }), { skipped: true });
});

test('notifyNtfy throws when ntfy rejects the publish', async () => {
  await assert.rejects(
    notifyNtfy(config, { topic: 'probe-alerts' }, {
      fetchImpl: async () => new Response('nope', { status: 413 }),
    }),
    /ntfy returned HTTP 413/,
  );
});
