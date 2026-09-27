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

  // Email has no priority field, so urgency is carried in the subject where it
  // survives threading and shows up in the inbox list.
  const header = recovery ? 'RECOVERED' : isUp ? 'UP' : 'DOWN';

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
    subject: `[${header}] RIPE Atlas probe ${probe.id} — ${
      observation.reachable ? observation.statusName : 'API unreachable'
    }`,
    text: lines.join('\n'),
  };
}

export async function notifyEmail(config, message, options = {}) {
  const { fetchImpl = globalThis.fetch } = options;
  if (!config.email.enabled) return { skipped: true };

  const url = config.email.apiUrl;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.email.apiKey}`,
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [config.email.to],
      subject: message.subject,
      text: message.text,
    }),
  });

  if (!response.ok) {
    // Resend explains the refusal in the body; surface it rather than the bare
    // status, which is what made a rate-limited push undiagnosable.
    const detail = await response.text().catch(() => '');
    throw new Error(
      `resend returned HTTP ${response.status} for ${url}${detail ? `: ${truncate(detail)}` : ''}`,
    );
  }

  return { skipped: false, url };
}

function truncate(text, max = 200) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
