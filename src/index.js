import { loadConfig } from './config.js';
import { readReport, runCheck } from './check.js';

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(request, adminToken) {
  if (!adminToken) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? constantTimeEquals(match[1].trim(), adminToken) : false;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function logSummary(result, trigger) {
  const parts = result.probes.map((probe) => {
    const state = !probe.reachable ? 'unreachable' : probe.status.name;
    const flags = [probe.changed ? 'CHANGED' : 'same', probe.alerted ? 'alerted' : 'no-alert'];
    return `${probe.id}=${state} [${flags.join(',')}]`;
  });
  console.log(`[${trigger}] ${parts.join(' ')}`);
}

export default {
  async scheduled(event, env) {
    const config = loadConfig(env);
    const result = await runCheck({ config, kv: env.STATE, fetchImpl: fetch });
    logSummary(result, event?.cron ?? 'scheduled');
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return json({ ok: true });
    }

    const adminToken = env.ADMIN_TOKEN;
    if (!adminToken) {
      return json({ error: 'ADMIN_TOKEN is not set; see README' }, 503);
    }
    if (!isAuthorized(request, adminToken)) {
      return json({ error: 'unauthorized' }, 401);
    }

    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      return json({ error: error?.message ?? 'bad configuration' }, 500);
    }

    if (url.pathname === '/report') {
      return json(await readReport({ config, kv: env.STATE }));
    }

    if (url.pathname === '/' || url.pathname === '/check') {
      const result = await runCheck({ config, kv: env.STATE, fetchImpl: fetch });
      logSummary(result, 'manual');
      return json(result);
    }

    return json(
      {
        error: 'not found',
        routes: ['/healthz (open)', '/report (auth)', '/ or /check (auth, runs a check now)'],
      },
      404,
    );
  },
};
