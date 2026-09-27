import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, parseProbeIds } from '../src/config.js';
import { buildMessage, notifyEmail } from '../src/notify.js';

const HOUR = 3600;
const T0 = 1_790_000_000;

const config = loadConfig({
  PROBE_IDS: '55311',
  RESEND_API_KEY: 're_test_key',
  ALERT_EMAIL_TO: 'ops@example.com',
});

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
    RESEND_API_KEY: 're_x',
    ALERT_EMAIL_TO: 'x@example.com',
    REQUEST_ATTEMPTS: '5',
    ALERT_ON_FIRST_RUN: 'true',
    RECOVERY_ALERT: 'no',
  });

  assert.equal(loaded.request.attempts, 5);
  assert.equal(loaded.alerting.alertOnFirstRun, true);
  assert.equal(loaded.alerting.recoveryAlert, false);
  assert.equal(loaded.email.enabled, true);
});

test('email needs both an api key and a recipient to be considered enabled', () => {
  const noKey = loadConfig({ PROBE_IDS: '1', ALERT_EMAIL_TO: 'ops@example.com' });
  const noRecipient = loadConfig({ PROBE_IDS: '1', RESEND_API_KEY: 're_x' });
  const blank = loadConfig({ PROBE_IDS: '1', RESEND_API_KEY: '  ', ALERT_EMAIL_TO: '' });

  assert.equal(noKey.email.enabled, false);
  assert.equal(noKey.alerting.enabled, false);
  assert.equal(noRecipient.email.enabled, false);
  assert.equal(noRecipient.alerting.enabled, false);
  assert.equal(blank.alerting.enabled, false);
});

test('a disconnect alert is urgent and names the probe', () => {
  const message = buildMessage(baseArgs);

  assert.equal(message.subject, '[DOWN] RIPE Atlas probe 55311 — Disconnected');
  assert.match(message.text, /Austin, TX Google Fiber · AS16591 · 136\.62\.1\.41 · US/);
  assert.match(message.text, /Status: Disconnected \(id 2\)/);
  assert.match(message.text, /API total uptime: 1796d 14h 56m/);
  assert.match(message.text, /Observed uptime: 99\.50%/);
  assert.match(message.text, /Uptime last 1d 0h 0m: 50\.00% \(2 checks\)/);
  assert.match(message.text, /^Checked: \d{4}-\d{2}-\d{2}T/m);
});

test('a recovery alert is calmer and mentions the previous status', () => {
  const message = buildMessage({
    ...baseArgs,
    recovery: true,
    observation: { ...observation, up: true, statusId: 1, statusName: 'Connected' },
  });

  assert.equal(message.subject, '[RECOVERED] RIPE Atlas probe 55311 — Connected');
  assert.match(message.text, /Previous: Connected/);
});

test('an unreachable API is reported as such', () => {
  const message = buildMessage({
    ...baseArgs,
    probe: { ...probe, statusName: 'unknown', statusId: null, totalUptimeSeconds: 0, statusSince: null },
    observation: { ...observation, reachable: false, error: 'HTTP 503 for https://atlas.ripe.net/api/v2/probes/55311' },
  });

  assert.match(message.subject, /\[DOWN\]/);
  assert.match(message.subject, /API unreachable/);
  assert.match(message.text, /Atlas API unreachable after 3 attempt\(s\): HTTP 503/);
});

test('notifyEmail posts a bearer-authenticated payload', async () => {
  const calls = [];
  const result = await notifyEmail(config, { subject: 's', text: 't' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response('{"id":"msg_1"}', { status: 200 });
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_test_key');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: 'RIPE Atlas alerts <onboarding@resend.dev>',
    to: ['ops@example.com'],
    subject: 's',
    text: 't',
  });
});

test('notifyEmail honours a custom from address and api url', async () => {
  const custom = loadConfig({
    RESEND_API_KEY: 're_test_key',
    ALERT_EMAIL_TO: 'ops@example.com',
    RESEND_API_URL: 'https://api.resend.example.com/',
    ALERT_EMAIL_FROM: 'Atlas <alerts@example.com>',
  });
  const calls = [];
  await notifyEmail(custom, { subject: 's', text: 't' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('{"id":"msg_1"}', { status: 200 });
    },
  });

  assert.deepEqual(calls, [
    { url: 'https://api.resend.example.com/emails', body: { from: 'Atlas <alerts@example.com>', to: ['ops@example.com'], subject: 's', text: 't' } },
  ]);
});

test('notifyEmail skips when unconfigured instead of throwing', async () => {
  const unconfigured = loadConfig({ PROBE_IDS: '1' });
  assert.deepEqual(
    await notifyEmail(unconfigured, { subject: 's' }, { fetchImpl: async () => assert.fail('must not send') }),
    { skipped: true },
  );
});

test('notifyEmail surfaces the provider error body, not just the status', async () => {
  await assert.rejects(
    notifyEmail(config, { subject: 's', text: 't' }, {
      fetchImpl: async () => new Response(
        '{"statusCode":429,"message":"Too many requests. You can only send 2 emails per second."}',
        { status: 429 },
      ),
    }),
    /resend returned HTTP 429 for https:\/\/api\.resend\.com\/emails: .*Too many requests/,
  );
});

test('notifyEmail makes a single attempt when the provider rate limits', async () => {
  let calls = 0;

  await assert.rejects(
    notifyEmail(config, { subject: 's', text: 't' }, {
      fetchImpl: async () => {
        calls += 1;
        return new Response('rate limited', { status: 429 });
      },
    }),
    /resend returned HTTP 429/,
  );
  // Retrying inside one invocation cannot help a per-second quota, and the
  // cross-run retry in state.js is what recovers a missed alert.
  assert.equal(calls, 1);
});
