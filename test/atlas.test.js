import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError, ParseError, fetchProbe, fetchWithRetry, normalizeProbe, probeUrl } from '../src/atlas.js';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const noSleep = async () => {};

test('probeUrl builds the documented endpoint', () => {
  assert.equal(probeUrl(55311), 'https://atlas.ripe.net/api/v2/probes/55311');
  assert.equal(probeUrl(55311, 'https://atlas.ripe.net/'), 'https://atlas.ripe.net/api/v2/probes/55311');
});

test('normalizeProbe maps a real payload', () => {
  const probe = normalizeProbe({
    id: 55311,
    address_v4: '136.62.1.41',
    asn_v4: 16591,
    country_code: 'US',
    description: 'Austin, TX Google Fiber',
    first_connected: 1593987276,
    last_connected: 1790392733,
    status: { id: 1, name: 'Connected', since: '2026-09-18T05:01:34Z' },
    status_since: 1789707694,
    total_uptime: 155228176,
  });

  assert.equal(probe.id, 55311);
  assert.equal(probe.statusId, 1);
  assert.equal(probe.statusName, 'Connected');
  assert.equal(probe.statusSince, 1789707694);
  assert.equal(probe.totalUptimeSeconds, 155228176);
  assert.equal(probe.asnV4, 16591);
  assert.equal(probe.isUp, true);
});

test('normalizeProbe treats every non-Connected status as down', () => {
  for (const [id, name] of [[0, 'Never Connected'], [2, 'Disconnected'], [3, 'Abandoned'], [4, 'Written Off']]) {
    assert.equal(normalizeProbe({ id: 1, status: { id, name } }).isUp, false, name);
  }
});

test('normalizeProbe rejects payloads without a usable status', () => {
  assert.throws(() => normalizeProbe(null), ParseError);
  assert.throws(() => normalizeProbe({ id: 1 }), ParseError);
  assert.throws(() => normalizeProbe({ id: 1, status: { name: 'Connected' } }), ParseError);
});

test('fetchWithRetry returns on the first success', async () => {
  let calls = 0;
  const response = await fetchWithRetry('https://example.test', {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true });
    },
    sleepImpl: noSleep,
  });

  assert.equal(calls, 1);
  assert.equal(await response.json().then((body) => body.ok), true);
});

test('fetchWithRetry retries 503 and then succeeds', async () => {
  const sleeps = [];
  let calls = 0;

  const response = await fetchWithRetry('https://example.test', {
    attempts: 3,
    backoffMs: 500,
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? jsonResponse({}, 503) : jsonResponse({ ok: true });
    },
    sleepImpl: async (ms) => sleeps.push(ms),
  });

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1000]);
  assert.equal(response.status, 200);
});

test('fetchWithRetry honours Retry-After', async () => {
  const sleeps = [];
  let calls = 0;

  await fetchWithRetry('https://example.test', {
    attempts: 2,
    backoffMs: 100,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 429, { 'retry-after': '7' });
      return jsonResponse({ ok: true });
    },
    sleepImpl: async (ms) => sleeps.push(ms),
  });

  assert.deepEqual(sleeps, [7000]);
});

test('fetchWithRetry does not retry a 404', async () => {
  let calls = 0;

  await assert.rejects(
    fetchWithRetry('https://example.test', {
      attempts: 3,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({}, 404);
      },
      sleepImpl: noSleep,
    }),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      return true;
    },
  );

  assert.equal(calls, 1);
});

test('fetchWithRetry gives up after the configured attempts', async () => {
  let calls = 0;

  await assert.rejects(
    fetchWithRetry('https://example.test', {
      attempts: 3,
      backoffMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({}, 500);
      },
      sleepImpl: noSleep,
    }),
    HttpError,
  );

  assert.equal(calls, 3);
});

test('fetchWithRetry retries network errors', async () => {
  let calls = 0;

  const response = await fetchWithRetry('https://example.test', {
    attempts: 2,
    backoffMs: 10,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return jsonResponse({ ok: true });
    },
    sleepImpl: noSleep,
  });

  assert.equal(calls, 2);
  assert.equal(response.status, 200);
});

test('fetchWithRetry caps a huge Retry-After', async () => {
  const sleeps = [];
  let calls = 0;

  await assert.rejects(
    fetchWithRetry('https://example.test', {
      attempts: 2,
      backoffMs: 100,
      maxDelayMs: 2000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({}, 503, { 'retry-after': '3600' });
      },
      sleepImpl: async (ms) => sleeps.push(ms),
    }),
    HttpError,
  );

  assert.deepEqual(sleeps, [2000]);
});

test('fetchProbe parses the body and flags a disconnected probe', async () => {
  const probe = await fetchProbe(55311, {
    fetchImpl: async () =>
      jsonResponse({ id: 55311, status: { id: 2, name: 'Disconnected' }, total_uptime: 42 }),
  });

  assert.equal(probe.id, 55311);
  assert.equal(probe.isUp, false);
  assert.equal(probe.totalUptimeSeconds, 42);
});

test('fetchProbe rejects a non-JSON body', async () => {
  await assert.rejects(
    fetchProbe(55311, {
      fetchImpl: async () => new Response('<html>gateway</html>', { status: 200 }),
    }),
    ParseError,
  );
});
