import { formatDuration, formatSince, formatTimestamp } from './format.js';

function locationLine(probe) {
  const parts = [];
  if (probe.description) parts.push(probe.description);
  if (Number.isFinite(probe.asnV4)) parts.push(`AS${probe.asnV4}`);
  if (probe.addressV4) parts.push(probe.addressV4);
  if (probe.countryCode) parts.push(probe.countryCode);
  return parts.join(' · ');
}

export function buildMessage({
  probe,
  observation,
  previous,
  observed,
  window,
  windowSeconds = 86_400,
  config,
  recovery,
}) {
  const isUp = Boolean(observation.reachable && observation.up);

  const header = recovery ? 'RECOVERED' : isUp ? 'UP' : 'DOWN';
  const title = `Atlas ${probe.id} ${header}`;

  const lines = [];
  const location = locationLine(probe);
  if (location) lines.push(location);

  if (!observation.reachable) {
    lines.push(`Atlas API unreachable after ${config.request.attempts} attempt(s): ${observation.error}`);
  } else {
    lines.push(`Status: ${probe.statusName} (id ${probe.statusId})`);
    if (Number.isFinite(probe.statusSince)) {
      lines.push(`Since: ${formatTimestamp(probe.statusSince)} (${formatSince(probe.statusSince, observation.checkedAt)})`);
    }
  }

  if (recovery && previous.lastStatusName) {
    lines.push(`Previous: ${previous.lastStatusName}`);
  }

  lines.push(`API total uptime: ${formatDuration(probe.totalUptimeSeconds)}`);
  if (observed.percent !== null) {
    lines.push(`Observed uptime: ${observed.percent.toFixed(2)}%`);
  }
  if (window.percent !== null) {
    lines.push(`Uptime last ${formatDuration(windowSeconds)}: ${window.percent.toFixed(2)}% (${window.checks} checks)`);
  }
  lines.push(`Checked: ${formatTimestamp(observation.checkedAt)}`);

  return {
    topic: config.ntfy.topic,
    title,
    message: lines.join('\n'),
    priority: recovery ? 2 : isUp ? 1 : 3,
    tags: recovery ? ['white_check_mark'] : isUp ? ['information_source'] : ['warning'],
  };
}

export async function notifyNtfy(config, message, options = {}) {
  const { fetchImpl = globalThis.fetch } = options;
  if (!config.ntfy.enabled) return { skipped: true };

  const url = `${config.ntfy.server}/${encodeURIComponent(config.ntfy.topic)}`;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`ntfy returned HTTP ${response.status} for ${url}`);
  }

  return { skipped: false, url };
}
