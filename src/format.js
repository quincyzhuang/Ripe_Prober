const SECONDS_PER_DAY = 86_400;

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatTimestamp(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return 'unknown';
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

export function formatSince(epochSeconds, nowSeconds) {
  if (!Number.isFinite(epochSeconds) || !Number.isFinite(nowSeconds)) return 'unknown';
  const delta = nowSeconds - epochSeconds;
  if (delta < 0) return 'in the future';
  return `${formatDuration(delta)} ago`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}%`;
}
