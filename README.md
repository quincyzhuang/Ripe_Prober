# Ripe_Prober

Watches a RIPE Atlas probe via the public API and emails you the moment the
probe disconnects.

- Polls `https://atlas.ripe.net/api/v2/probes/{id}` on a schedule (hourly by default)
- Retries transient HTTP failures with exponential backoff before giving up
- Emails via [Resend](https://resend.com) — no shared-IP rate limit to fight
- Alerts on **transitions only**, so a three-day outage is one email, not 72
- Reports the probe's cumulative `total_uptime` plus its own observed uptime
- Runs on Cloudflare Workers, so nothing needs to be running on your machine

## Quick start

Requires Node 20+ and a free Cloudflare account.

```bash
npm install
npx wrangler login

# 1. Create the KV store used for state and uptime history.
npx wrangler kv namespace create STATE
#    paste the printed id into wrangler.jsonc, replacing REPLACE_ME_...

# 2. Set the secrets.
npx wrangler secret put RESEND_API_KEY  # from resend.com -> API keys
npx wrangler secret put ADMIN_TOKEN    # any long random string

# ALERT_EMAIL_TO is not a secret but has no safe default, so set it explicitly.
npx wrangler secret put ALERT_EMAIL_TO  # where the alerts should go

# 3. Deploy.
npx wrangler deploy
```

The default sender is Resend's shared `onboarding@resend.dev`, which needs no DNS
setup of your own. For a cleaner `From:` address, verify a domain at
resend.com and set `ALERT_EMAIL_FROM` to match. Note that SPF, DKIM and DMARC are
checked by the *recipient* against the sending domain — sending to Gmail makes
them matter, not the other way round.

## Configuration

All of these live under `vars` in `wrangler.jsonc`; secrets do not.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PROBE_IDS` | `55311` | Comma-separated probe ids, e.g. `"55311,55312"`. All are tracked independently. |
| `triggers.crons` | `0 * * * *` | Schedule. Hourly; use `*/15 * * * *` for 15-minute, `*/5 * * * *` for 5-minute checks. |
| `ATLAS_BASE_URL` | `https://atlas.ripe.net` | Only change to point at a test double. |
| `RESEND_API_KEY` | — | **Required secret.** Without it, alerting is disabled. |
| `ALERT_EMAIL_TO` | — | **Required.** Recipient address. Without it, alerting is disabled. |
| `ALERT_EMAIL_FROM` | `RIPE Atlas alerts <onboarding@resend.dev>` | Sender. Override once a domain is verified. |
| `RESEND_API_URL` | `https://api.resend.com` | Only change to point at a test double. |
| `REQUEST_ATTEMPTS` | `3` | Total attempts per check, including the first. |
| `RETRY_BACKOFF_MS` | `500` | Base for exponential backoff (`500ms`, `1s`, `2s`, …). |
| `MAX_RETRY_DELAY_MS` | `30000` | Ceiling, also applied to a server's `Retry-After`. |
| `REQUEST_TIMEOUT_MS` | `10000` | Per-attempt timeout. |
| `ALERT_ON_FIRST_RUN` | `false` | Push if the probe is already down at deploy time. A healthy first run is always treated as baseline. |
| `RECOVERY_ALERT` | `true` | Push again when it comes back. |
| `HISTORY_LIMIT` | `720` | Checks retained per probe (~30 days at hourly). |
| `OBSERVED_WINDOW_SECONDS` | `86400` | Window for the "uptime last 24h" figure. |
| `MAX_SAMPLE_SECONDS` | `21600` | Longest gap attributed to uptime. Anything longer counts as unknown instead of silently inflating uptime. |

Retries happen on network errors and on `408`, `425`, `429`, `500`, `502`,
`503`, `504`. Other `4xx` responses fail immediately — a `404` will not become a
`200` by asking again.

### KV writes

The Workers KV **binding** only supports `put(key, value)`. There is no bulk-put
overload — bulk writes exist in the REST API and in `wrangler kv bulk put`, but
passing an array to the binding fails with
`parameter 2 is not of type 'string or Object'`. Each probe is therefore written
with its own `put` call, so a check of N probes costs N writes. Budget one KV
write per probe per interval against your plan's daily write limit: hourly
checks of a single probe use ~24 writes/day.

Bulk **get** is supported by the binding, and is used to load all probes in one
read.

## HTTP endpoints

```bash
# open, no auth — liveness probe for Cloudflare
curl https://ripe-prober.<subdomain>.workers.dev/healthz

# last stored state, no call to the Atlas API
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://.../report

# run a check right now (and alert if something changed)
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://.../
```

`/report` returns the shape of one check:

```json
{
  "checkedAt": 1790392800,
  "alerting": true,
  "probes": [
    {
      "id": 55311,
      "up": true,
      "reachable": true,
      "changed": false,
      "status": { "id": 1, "name": "Connected", "since": 1789707694 },
      "totalUptimeSeconds": 155228176,
      "observed": { "up": 3600, "down": 0, "unknown": 0, "total": 3600, "percent": 100 },
      "window": { "checks": 2, "up": 2, "down": 0, "unknown": 0, "percent": 100 }
    }
  ]
}
```

`totalUptimeSeconds` is Atlas's own figure, straight from `total_uptime`.
`observed` and `window` are computed from this worker's own polling.

## How status is interpreted

Atlas reports one of five status ids. Only `1` counts as up; everything else is
treated as down.

| id | name | treated as |
| --- | --- | --- |
| 0 | Never Connected | down |
| 1 | Connected | **up** |
| 2 | Disconnected | down |
| 3 | Abandoned | down |
| 4 | Written Off | down |

If the Atlas API itself cannot be reached after all retries, the probe is
recorded as `unreachable` — its own distinct state, so recovery of the API does
not masquerade as recovery of the probe.

Uptime accounting credits the interval between two checks to the state observed
at the **end** of that interval. This deliberately over-reports downtime rather
than under-reporting it, and it means a check that fails after all retries costs
a full interval.

## Development

```bash
npm test              # 53 unit + integration tests, no network access
npm run check:local   # scripted up -> down -> down -> up -> API-down walkthrough
npm run dev           # wrangler dev with .dev.vars
```

`npm run check:local` prints one line per simulated check plus every push that
would have been sent. To send real ones:

```bash
RESEND_API_KEY=re_... ALERT_EMAIL_TO=you@example.com npm run check:local -- --notify
```

For `npm run dev`, copy `.dev.vars.example` to `.dev.vars` and fill in the
topic and token.

### Layout

| File | Role |
| --- | --- |
| `src/index.js` | Worker entry: cron handler and HTTP routes. |
| `src/check.js` | Orchestrates fetch -> state -> notify. |
| `src/atlas.js` | HTTP client with retries; payload normalisation. |
| `src/state.js` | Pure state, uptime accounting, KV adapter. |
| `src/notify.js` | Email message construction and Resend delivery. |
| `src/config.js` | Environment parsing. |
| `src/format.js` | Duration and timestamp formatting. |
| `test/` | `node --test` suites. |
| `scripts/local-check.js` | Offline walkthrough harness. |

Everything in `src/` except `index.js` is free of Workers-specific APIs, so the
logic is tested with plain Node.

## Adding email instead of (or as well as) push

`src/notify.js` has a single delivery function. To add a second channel, call it
from the same place in `runCheck` that calls `notifyEmail`. No changes to the
state machine are needed — the transition bookkeeping in `src/state.js` keys off
the probe status, not the transport.

## Notes

- If Atlas itself is down, you get an "API unreachable" email. That is a
  distinct alert from a probe disconnect, so you can tell the two apart.
- The free Cloudflare plan is fine for hourly checks. Check your plan's minimum
  cron interval before going below 15 minutes.
- Nothing is stored but the two numbers per check and the last status; the
  API key and recipient address are only ever sent to Resend.
