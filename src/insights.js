/**
 * Observations about recorded HAR requests, with no network access or inferred
 * root causes. Endpoint identity intentionally excludes queries and fragments.
 */

const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_TIME = 30 * 24 * 60 * 60 * 1000;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const TIME_PHASES = ['blocked', 'dns', 'connect', 'send', 'wait', 'receive'];

function bounded(value, fallback = 0, min = 0, max = MAX_NUMBER) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback;
}

function nearestRank95(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.ceil(values.length * 0.95) - 1];
}

/** Keep original summaries, exports, and observations on the same time basis. */
export function requestDuration(entry) {
  const phaseSum = TIME_PHASES.reduce((sum, phase) => sum + bounded(entry?.timings?.[phase], 0, 0, MAX_TIME), 0);
  // SSL is contained in connect; including it again would double count it.
  return bounded(entry?.time, Math.min(MAX_TIME, phaseSum), 0, MAX_TIME);
}

function endpointIdentity(request) {
  const method = typeof request?.method === 'string' && METHODS.has(request.method.toUpperCase())
    ? request.method.toUpperCase() : 'OTHER';
  let origin = 'invalid-origin';
  let url = '';
  let host = '';
  let path = '/';
  if (typeof request?.url === 'string') {
    try {
      const parsed = new URL(request.url);
      if (PROTOCOLS.has(parsed.protocol)) {
        origin = parsed.origin;
        host = parsed.host;
        path = parsed.pathname || '/';
        url = `${origin}${path}`;
      }
    } catch {
      // A missing or invalid URL has a neutral identity, never a fetched URL.
    }
  }
  return { key: JSON.stringify([method, origin, path]), method, url, host, path };
}

/**
 * Analyze without mutating the HAR. failureRate is a fraction in [0, 1]. P95
 * uses nearest rank over normalized durations: finite numeric time, or sums of
 * recorded phases when time is unavailable. Completely unavailable durations
 * count as zero, matching strict HAR exports, and can understate these metrics.
 * Numeric values follow the core HAR bounds. Returned
 * URL strings are untrusted and must be escaped by their rendering context.
 */
export function analyzeTrace(har) {
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const groups = new Map();
  const allTimes = [];
  const observed = new Map([
    ['network-errors', { severity: 'error', indices: [], metrics: { slowestMs: 0 } }],
    ['status-5xx', { severity: 'error', indices: [], metrics: { slowestMs: 0, statuses: {} } }],
    ['status-4xx', { severity: 'warning', indices: [], metrics: { slowestMs: 0, statuses: {} } }],
    ['slow-ttfb', { severity: 'warning', indices: [], metrics: { slowestMs: 0, maxWaitMs: 0, maxWaitShare: 0 } }],
    ['slow-download', { severity: 'warning', indices: [], metrics: { slowestMs: 0, maxReceiveMs: 0, maxReceiveShare: 0 } }],
  ]);
  let failureCount = 0;
  let slowRequests = 0;

  function record(id, index, time, status) {
    const finding = observed.get(id);
    finding.indices.push(index);
    finding.metrics.slowestMs = Math.max(finding.metrics.slowestMs, time);
    if (finding.metrics.statuses) {
      finding.metrics.statuses[status] = (finding.metrics.statuses[status] || 0) + 1;
    }
    return finding.metrics;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const time = requestDuration(entry);
    const status = Math.trunc(bounded(entry?.response?.status, 0, 0, 599));
    const failed = status === 0 || status >= 400;
    const bodySize = bounded(entry?.response?.bodySize, -1, -1);
    const responseBytes = bodySize >= 0 ? bodySize : Math.trunc(bounded(entry?.response?.content?.size));
    const identity = endpointIdentity(entry?.request);
    if (!groups.has(identity.key)) {
      groups.set(identity.key, {
        ...identity, count: 0, failures: 0, p95Ms: 0, avgMs: 0,
        totalTimeMs: 0, totalBytes: 0, statuses: {}, indices: [], _times: [],
      });
    }
    const group = groups.get(identity.key);
    group.count += 1;
    group.failures += failed ? 1 : 0;
    group.totalTimeMs = Math.min(MAX_NUMBER, group.totalTimeMs + time);
    group.totalBytes = Math.min(MAX_NUMBER, group.totalBytes + responseBytes);
    group.statuses[status] = (group.statuses[status] || 0) + 1;
    group.indices.push(index);
    allTimes.push(time);
    group._times.push(time);
    if (failed) failureCount += 1;
    if (time >= 1000) slowRequests += 1;
    if (status === 0) record('network-errors', index, time, status);
    else if (status >= 500) record('status-5xx', index, time, status);
    else if (status >= 400) record('status-4xx', index, time, status);

    if (time >= 1000) {
      const wait = bounded(entry?.timings?.wait, 0, 0, MAX_TIME);
      const receive = bounded(entry?.timings?.receive, 0, 0, MAX_TIME);
      if (wait / time >= 0.7) {
        const metrics = record('slow-ttfb', index, time, status);
        metrics.maxWaitMs = Math.max(metrics.maxWaitMs, wait);
        metrics.maxWaitShare = Math.max(metrics.maxWaitShare, wait / time);
      }
      if (receive / time >= 0.5) {
        const metrics = record('slow-download', index, time, status);
        metrics.maxReceiveMs = Math.max(metrics.maxReceiveMs, receive);
        metrics.maxReceiveShare = Math.max(metrics.maxReceiveShare, receive / time);
      }
    }
  }

  const findings = [...observed].filter(([, finding]) => finding.indices.length)
    .map(([id, finding]) => ({ id, severity: finding.severity, count: finding.indices.length, indices: finding.indices, metrics: finding.metrics }));
  const endpoints = [];
  const repeatedIndices = [];
  let repeatedEndpointCount = 0;
  let maxCount = 0;
  let repeatedSlowestMs = 0;
  for (const group of groups.values()) {
    if (group.count >= 3 && group.url) {
      repeatedEndpointCount += 1;
      maxCount = Math.max(maxCount, group.count);
      for (const index of group.indices) repeatedIndices.push(index);
      for (const time of group._times) repeatedSlowestMs = Math.max(repeatedSlowestMs, time);
    }
    const { _times, ...endpoint } = group;
    endpoint.p95Ms = nearestRank95(_times);
    endpoint.avgMs = _times.length ? group.totalTimeMs / _times.length : 0;
    endpoints.push(endpoint);
  }
  if (repeatedIndices.length) {
    repeatedIndices.sort((a, b) => a - b);
    findings.push({
      id: 'repeated-requests', severity: 'info', count: repeatedIndices.length, indices: repeatedIndices,
      metrics: { endpointCount: repeatedEndpointCount, maxCount, slowestMs: repeatedSlowestMs },
    });
  }
  // First source index makes ties stable regardless of engine sort behavior.
  endpoints.sort((a, b) => b.totalTimeMs - a.totalTimeMs || a.indices[0] - b.indices[0]);
  return {
    stats: {
      slowRequests,
      failureRate: entries.length ? failureCount / entries.length : 0,
      p95Ms: nearestRank95(allTimes),
    },
    findings,
    endpoints,
  };
}
