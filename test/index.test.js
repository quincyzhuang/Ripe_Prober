import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { MemoryKv } from '../scripts/memory-kv.js';

const TOKEN = 'super-secret-admin-token';

const payload = {
  id: 55311,
  address_v4: '136.62.1.41',
  asn_v4: 16591,
  country_code: 'US',
  description: 'Austin, TX Google Fiber',
  status: { id: 1, name: 'Connected', since: '2026-09-18T05:01:34Z' },
  status_since: 1_789_707_694,
  total_uptime: 155_228_176,
};

function makeEnv(overrides = {}) {
  return {
    STATE: new MemoryKv(),
    PROBE_IDS: '55311',
    NTFY_TOPIC: 'probe-alerts',
    ADMIN_TOKEN: TOKEN,
    RETRY_BACKOFF_MS: '0',
    ...overrides,
  };
}

function stubAtlasFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('atlas.ripe.net')) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (init) return new Response('ok', { status: 200 });
    return new Response('ok', { status: 200 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

const authed = (url = 'https://probe.example.com/') =>
  new Request(url, { headers: { authorization: `Bearer ${TOKEN}` } });

test('GET /healthz needs no token', async () => {
  const response = await worker.fetch(new Request('https://probe.example.com/healthz'), makeEnv());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('every other route requires a bearer token', async () => {
  for (const path of ['/', '/check', '/report']) {
    const missing = await worker.fetch(new Request(`https://probe.example.com${path}`), makeEnv());
    assert.equal(missing.status, 401, path);

    const wrong = await worker.fetch(
      new Request(`https://probe.example.com${path}`, { headers: { authorization: 'Bearer nope' } }),
      makeEnv(),
    );
    assert.equal(wrong.status, 401, path);
  }
});

test('a token of the wrong length is rejected without leaking detail', async () => {
  const response = await worker.fetch(
    new Request('https://probe.example.com/report', { headers: { authorization: `Bearer ${TOKEN}x` } }),
    makeEnv(),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});

test('an unset ADMIN_TOKEN fails closed with 503', async () => {
  const response = await worker.fetch(new Request('https://probe.example.com/report'), makeEnv({ ADMIN_TOKEN: '' }));
  assert.equal(response.status, 503);
});

test('GET / runs a check and returns the report', async () => {
  const restore = stubAtlasFetch();
  try {
    const response = await worker.fetch(authed(), makeEnv());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = await response.json();
    assert.equal(body.probes[0].id, 55311);
    assert.equal(body.probes[0].up, true);
  } finally {
    restore();
  }
});

test('GET /report serves stored state without touching the API', async () => {
  const env = makeEnv();
  const restore = stubAtlasFetch();
  try {
    await worker.fetch(authed(), env);
    const original = globalThis.fetch;
    globalThis.fetch = async () => assert.fail('report must not call out');

    const response = await worker.fetch(authed('https://probe.example.com/report'), env);
    const body = await response.json();
    assert.equal(body.probes[0].status.name, 'Connected');
    assert.equal(body.probes[0].totalUptimeSeconds, 155_228_176);
    globalThis.fetch = original;
  } finally {
    restore();
  }
});

test('unknown paths 404 with a route listing', async () => {
  const response = await worker.fetch(authed('https://probe.example.com/nope'), makeEnv());
  assert.equal(response.status, 404);

  const body = await response.json();
  assert.equal(body.error, 'not found');
  assert.ok(body.routes.some((route) => route.startsWith('/healthz')));
});

test('a bad PROBE_IDS value returns 500 instead of throwing', async () => {
  const response = await worker.fetch(authed(), makeEnv({ PROBE_IDS: 'not-a-number' }));
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /at least one numeric probe id/);
});

test('the scheduled handler stores state', async () => {
  const env = makeEnv();
  const restore = stubAtlasFetch();
  try {
    await worker.scheduled({ cron: '0 * * * *' }, env);
    const stored = JSON.parse(await env.STATE.get('probe:55311'));
    assert.equal(stored.state.lastKey, 'status:1');
    assert.equal(stored.history.length, 1);
  } finally {
    restore();
  }
});
