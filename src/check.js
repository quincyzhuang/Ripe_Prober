import { fetchProbe } from './atlas.js';
import {
  KvStore,
  UNREACHABLE_KEY,
  applyObservation,
  isRecovery,
  observedTotals,
  pushHistory,
  shouldAlert,
  windowUptime,
} from './state.js';
import { buildMessage, notifyNtfy } from './notify.js';

async function observe(probeId, config, fetchImpl) {
  try {
    const probe = await fetchProbe(probeId, {
      baseUrl: config.baseUrl,
      attempts: config.request.attempts,
      backoffMs: config.request.backoffMs,
      maxDelayMs: config.request.maxDelayMs,
      timeoutMs: config.request.timeoutMs,
      fetchImpl,
    });

    return {
      probe,
      observation: {
        checkedAt: null,
        reachable: true,
        up: probe.isUp,
        statusId: probe.statusId,
        statusName: probe.statusName,
        statusSince: probe.statusSince,
        totalUptimeSeconds: probe.totalUptimeSeconds,
        error: null,
      },
    };
  } catch (error) {
    return {
      probe: null,
      observation: {
        checkedAt: null,
        reachable: false,
        up: false,
        statusId: null,
        statusName: UNREACHABLE_KEY,
        statusSince: null,
        totalUptimeSeconds: null,
        error: error?.message ?? String(error),
      },
    };
  }
}

function probeStub(probeId, previousState) {
  return {
    id: probeId,
    statusId: null,
    statusName: UNREACHABLE_KEY,
    statusSince: null,
    totalUptimeSeconds: previousState?.totalUptimeSeconds ?? 0,
    description: null,
    addressV4: null,
    asnV4: null,
    countryCode: null,
  };
}

function summarize(probeId, { state, previous, observation, probe, isInitial, changed, alerted, suppressed, recovery, observed, window }) {
  const resolved = probe ?? probeStub(probeId, state);
  const up = Boolean(observation.reachable && observation.up);

  return {
    id: probeId,
    checkedAt: observation.checkedAt,
    reachable: observation.reachable,
    up,
    changed,
    isInitial,
    alerted,
    suppressed,
    recovery,
    error: observation.error,
    status: {
      id: observation.reachable ? observation.statusId : null,
      name: observation.reachable ? observation.statusName : UNREACHABLE_KEY,
      since: observation.reachable ? observation.statusSince : null,
    },
    previousStatus: {
      id: previous.lastStatusId,
      name: previous.lastStatusName,
      since: previous.lastStatusSince,
    },
    probe: {
      description: resolved.description,
      addressV4: resolved.addressV4,
      addressV6: resolved.addressV6,
      asnV4: resolved.asnV4,
      asnV6: resolved.asnV6,
      countryCode: resolved.countryCode,
      firstConnected: resolved.firstConnected ?? null,
      lastConnected: resolved.lastConnected ?? null,
    },
    totalUptimeSeconds: resolved.totalUptimeSeconds,
    observed,
    window,
  };
}

export async function runCheck({ config, kv, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const checkedAtSeconds = Math.floor(now() / 1000);
  const store = new KvStore(kv);
  const records = await store.loadMany(config.probeIds);

  const results = [];
  const nextRecords = new Map();

  // Sequential on purpose: this is one request per hour and it keeps us from
  // hammering a public API.
  for (const probeId of config.probeIds) {
    const record = records.get(probeId);
    const { probe, observation } = await observe(probeId, config, fetchImpl);
    observation.checkedAt = checkedAtSeconds;

    const applied = applyObservation(record.state, observation, {
      maxSampleSeconds: config.uptime.maxSampleSeconds,
    });
    const history = pushHistory(record.history, observation, { limit: config.history.limit });
    const observed = observedTotals(applied.state);
    const window = windowUptime(history, {
      nowSeconds: checkedAtSeconds,
      windowSeconds: config.uptime.observedWindowSeconds,
    });
    const recovery = isRecovery({ previous: applied.previous, observation });

    let alerted = false;
    let suppressed = false;

    // A healthy baseline is not news: alertOnFirstRun exists to tell you the
    // probe was already broken when you deployed, not to confirm it is fine.
    const healthyBaseline = applied.isInitial && observation.reachable && observation.up === true;

    if (healthyBaseline) {
      suppressed = true;
    } else if (
      shouldAlert({ isInitial: applied.isInitial, changed: applied.changed, alerting: config.alerting })
    ) {
      if (recovery && !config.alerting.recoveryAlert) {
        suppressed = true;
      } else {
        const message = buildMessage({
          probe: probe ?? probeStub(probeId, applied.state),
          observation,
          previous: applied.previous,
          observed,
          window,
          windowSeconds: config.uptime.observedWindowSeconds,
          config,
          recovery,
        });
        try {
          await notifyNtfy(config, message, { fetchImpl });
          alerted = true;
          applied.state.lastAlertedKey = applied.key;
          applied.state.lastAlertedAt = observation.checkedAt;
        } catch (error) {
          suppressed = true;
          console.error(`ntfy publish failed for probe ${probeId}: ${error?.message ?? error}`);
        }
      }
    }

    nextRecords.set(probeId, { state: applied.state, history });

    results.push(
      summarize(probeId, {
        state: applied.state,
        previous: applied.previous,
        observation,
        probe,
        isInitial: applied.isInitial,
        changed: applied.changed,
        alerted,
        suppressed,
        recovery,
        observed,
        window,
      }),
    );
  }

  await store.saveMany(nextRecords);

  return { checkedAt: checkedAtSeconds, alerting: config.alerting.enabled, probes: results };
}

/** Read-only view of the last stored result. Does not hit the Atlas API. */
export async function readReport({ config, kv, now = () => Date.now() }) {
  const checkedAtSeconds = Math.floor(now() / 1000);
  const store = new KvStore(kv);
  const records = await store.loadMany(config.probeIds);

  return {
    checkedAt: checkedAtSeconds,
    alerting: config.alerting.enabled,
    probes: config.probeIds.map((probeId) => {
      const { state, history } = records.get(probeId);
      const observation = {
        checkedAt: state.lastCheckedAt ?? 0,
        reachable: state.lastError === null,
        up: state.lastKey === 'status:1',
        statusId: state.lastStatusId,
        statusName: state.lastStatusName,
        statusSince: state.lastStatusSince,
        totalUptimeSeconds: state.totalUptimeSeconds,
        error: state.lastError,
      };
      return summarize(probeId, {
        state,
        previous: { lastKey: state.lastKey, lastStatusId: null, lastStatusName: null, lastStatusSince: null },
        observation,
        probe: null,
        isInitial: false,
        changed: false,
        alerted: false,
        suppressed: false,
        recovery: false,
        observed: observedTotals(state),
        window: windowUptime(history, {
          nowSeconds: checkedAtSeconds,
          windowSeconds: config.uptime.observedWindowSeconds,
        }),
      });
    }),
  };
}
