import { MemoryKv } from './memory-kv.js';
import { loadConfig } from '../src/config.js';
import { runCheck } from '../src/check.js';

const HOUR = 3600;
const T0 = 1_790_000_000;

const NOTIFY = process.argv.includes('--notify');

const config = loadConfig({
  PROBE_IDS: process.env.PROBE_IDS ?? '55311',
  NTFY_TOPIC: NOTIFY ? process.env.NTFY_TOPIC : 'local-check-noop',
  RETRY_BACKOFF_MS: '0',
});

function probePayload(statusId, statusName) {
  return {
    id: 55311,
    status: { id: statusId, name: statusName, since: '2026-09-18T05:01:34Z' },
    status_since: 1_789_707_694,
    total_uptime: 155_228_176,
    address_v4: '136.62.1.41',
    asn_v4: 16591,
    country_code: 'US',
    description: 'Austin, TX Google Fiber',
    first_connected: 1_593_987_276,
    last_connected: 1_790_392_733,
  };
}

const kv = new MemoryKv();
const publishes = [];

function makeFetch({ statusId, statusName, atlasFails = false }) {
  return async (url, init) => {
    if (String(url).includes('atlas.ripe.net')) {
      if (atlasFails) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(probePayload(statusId, statusName)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    publishes.push({ url, body: JSON.parse(init.body) });
    return new Response('ok', { status: 200 });
  };
}

async function step(label, options, offsetHours) {
  const result = await runCheck({
    config,
    kv,
    fetchImpl: makeFetch(options),
    now: () => (T0 + offsetHours * HOUR) * 1000,
  });
  const probe = result.probes[0];
  console.log(
    [
      label.padEnd(22),
      `status=${String(probe.status.name).padEnd(13)}`,
      `changed=${String(probe.changed).padEnd(5)}`,
      `alerted=${String(probe.alerted).padEnd(5)}`,
      `observed=${probe.observed.percent === null ? 'n/a' : `${probe.observed.percent.toFixed(2)}%`}`,
    ].join('  '),
  );
}

console.log(`probes: ${config.probeIds.join(', ')}   notify: ${NOTIFY ? 'yes' : 'no (no-op topic)'}\n`);

await step('1. first run', { statusId: 1, statusName: 'Connected' }, 0);
await step('2. still up', { statusId: 1, statusName: 'Connected' }, 1);
await step('3. DISCONNECTED', { statusId: 2, statusName: 'Disconnected' }, 2);
await step('4. still down', { statusId: 2, statusName: 'Disconnected' }, 3);
await step('5. recovered', { statusId: 1, statusName: 'Connected' }, 4);
await step('6. atlas API down', { statusId: 1, statusName: 'Connected', atlasFails: true }, 5);

console.log(`\ntotal ntfy publishes: ${publishes.length}`);
for (const publish of publishes) {
  console.log(`  [${publish.body.priority}] ${publish.body.title} (${publish.body.tags.join(',')})`);
}
