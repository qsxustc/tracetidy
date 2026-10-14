/**
 * Compare two local recordings by the same endpoint identity used by insights.
 * Original endpoint strings stay in the private comparison result. Markdown
 * exports deliberately use generated endpoint aliases, even for raw inputs.
 */

import { analyzeTrace } from './insights.js';

const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_TIME = 30 * 24 * 60 * 60 * 1000;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const CLASSIFICATIONS = ['regressed', 'added', 'removed', 'improved', 'unchanged'];
const METRICS = ['count', 'failures', 'failureRate', 'avgMs', 'p95Ms', 'totalTimeMs', 'totalBytes'];
const ZERO_METRICS = Object.freeze(Object.fromEntries(METRICS.map((key) => [key, 0])));

function thresholdsFrom(options) {
  const { latencyMs = 100, latencyPercent = 20 } = options;
  for (const [key, value, maximum] of [['latencyMs', latencyMs, MAX_TIME], ['latencyPercent', latencyPercent, MAX_NUMBER]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
      throw new Error(`${key} must be a finite, nonnegative number no greater than ${maximum}.`);
    }
  }
  return { latencyMs, latencyPercent };
}

function metricsFor(endpoint) {
  if (!endpoint) return null;
  return {
    count: endpoint.count,
    failures: endpoint.failures,
    failureRate: endpoint.count ? endpoint.failures / endpoint.count : 0,
    avgMs: endpoint.avgMs,
    p95Ms: endpoint.p95Ms,
    totalTimeMs: endpoint.totalTimeMs,
    totalBytes: endpoint.totalBytes,
  };
}

function percentage(before, after) {
  // A zero baseline has no meaningful percent denominator. Keep the result
  // JSON-safe rather than representing a new measurable duration as Infinity.
  return before > 0 ? Math.max(-MAX_NUMBER, Math.min(MAX_NUMBER, (after - before) / before * 100)) : null;
}

function metricDeltas(before, after) {
  const baseline = before || ZERO_METRICS;
  const current = after || ZERO_METRICS;
  const deltas = Object.fromEntries(METRICS.map((key) => [key, current[key] - baseline[key]]));
  for (const key of ['avgMs', 'p95Ms', 'totalTimeMs', 'totalBytes']) {
    deltas[`${key}Percent`] = percentage(baseline[key], current[key]);
  }
  return deltas;
}

function classify(baseline, current, thresholds) {
  if (!baseline) return { classification: 'added', reasons: [] };
  if (!current) return { classification: 'removed', reasons: [] };
  const difference = current.p95Ms - baseline.p95Ms;
  // Multiplication supports zero baselines without nonfinite arithmetic and
  // includes exact threshold boundaries without division rounding surprises.
  const meaningfulLatency = Math.abs(difference) >= thresholds.latencyMs
    && Math.abs(difference) >= baseline.p95Ms * thresholds.latencyPercent / 100;
  const reasons = [];
  if (difference > 0 && meaningfulLatency) reasons.push('p95-regression');
  if (current.failureRate > baseline.failureRate) reasons.push('failure-rate-regression');
  if (difference < 0 && meaningfulLatency) reasons.push('p95-improvement');
  if (current.failureRate < baseline.failureRate) reasons.push('failure-rate-improvement');
  return {
    classification: reasons.some((reason) => reason.endsWith('-regression')) ? 'regressed'
      : reasons.length ? 'improved' : 'unchanged',
    reasons,
  };
}

function recordingMetrics(analysis) {
  let requestCount = 0;
  let failureCount = 0;
  let totalTimeMs = 0;
  let totalBytes = 0;
  for (const endpoint of analysis.endpoints) {
    requestCount += endpoint.count;
    failureCount += endpoint.failures;
    totalTimeMs = Math.min(MAX_NUMBER, totalTimeMs + endpoint.totalTimeMs);
    totalBytes = Math.min(MAX_NUMBER, totalBytes + endpoint.totalBytes);
  }
  return {
    requestCount, failureCount,
    failureRate: analysis.stats.failureRate,
    avgMs: requestCount ? totalTimeMs / requestCount : 0,
    p95Ms: analysis.stats.p95Ms,
    totalTimeMs, totalBytes,
  };
}

/**
 * Match method, origin and exact path, ignoring queries and fragments.
 * thresholds.latencyMs and thresholds.latencyPercent apply together to P95.
 * Any failure-rate increase is a regression; regression evidence wins when a
 * group also improves on another metric. Added and removed endpoints are kept
 * separate from regressions because there is no paired latency evidence.
 * Durations, failures and response bytes use analyzeTrace normalization.
 * Unknown timing is zero and status zero counts as failure. No input mutation.
 * Endpoint URLs and keys are private, untrusted strings: escape them in a UI.
 */
export function compareTraces(baselineHar, currentHar, options = {}) {
  const thresholds = thresholdsFrom(options);
  const baselineAnalysis = analyzeTrace(baselineHar);
  const currentAnalysis = analyzeTrace(currentHar);
  const baselineByKey = new Map(baselineAnalysis.endpoints.map((endpoint) => [endpoint.key, endpoint]));
  const currentByKey = new Map(currentAnalysis.endpoints.map((endpoint) => [endpoint.key, endpoint]));
  const keys = [...new Set([...baselineByKey.keys(), ...currentByKey.keys()])].sort();
  const counts = Object.fromEntries(['added', 'removed', 'regressed', 'improved', 'unchanged'].map((key) => [key, 0]));
  const endpoints = keys.map((key, index) => {
    const before = baselineByKey.get(key);
    const after = currentByKey.get(key);
    const identity = after || before;
    const baseline = metricsFor(before);
    const current = metricsFor(after);
    const result = classify(baseline, current, thresholds);
    counts[result.classification] += 1;
    return {
      id: `endpoint-${index + 1}`, key,
      method: identity.method, url: identity.url, host: identity.host, path: identity.path,
      baseline, current,
      baselineIndices: [...(before?.indices || [])], currentIndices: [...(after?.indices || [])],
      delta: metricDeltas(baseline, current),
      ...result,
    };
  });
  endpoints.sort((a, b) => CLASSIFICATIONS.indexOf(a.classification) - CLASSIFICATIONS.indexOf(b.classification)
    || b.delta.p95Ms - a.delta.p95Ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const baseline = recordingMetrics(baselineAnalysis);
  const current = recordingMetrics(currentAnalysis);
  const deltas = metricDeltas(
    { ...baseline, count: baseline.requestCount, failures: baseline.failureCount },
    { ...current, count: current.requestCount, failures: current.failureCount },
  );
  const { count, failures, ...delta } = deltas;
  return { thresholds, baseline, current, delta: { requestCount: count, failureCount: failures, ...delta }, counts, endpoints };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function duration(value) {
  return `${Math.round(finite(value))} ms`;
}

function size(value) {
  const amount = finite(value);
  if (Math.abs(amount) < 1024) return `${Math.round(amount)} B`;
  if (Math.abs(amount) < 1024 * 1024) return `${(amount / 1024).toFixed(1)} KiB`;
  return `${(amount / (1024 * 1024)).toFixed(2)} MiB`;
}

function signed(value, format = (amount) => String(amount)) {
  const amount = finite(value);
  return `${amount > 0 ? '+' : ''}${format(amount)}`;
}

function percent(value) {
  return `${(finite(value) * 100).toFixed(1)}%`;
}

function latencyDelta(endpoint) {
  if (!endpoint.baseline || !endpoint.current) return '—';
  const relative = endpoint.delta?.p95MsPercent;
  return `${signed(endpoint.delta?.p95Ms, duration)}${relative === null || !Number.isFinite(relative) ? '' : ` (${signed(relative, (value) => `${value.toFixed(1)}%`)})`}`;
}

/**
 * Build a safe Markdown report from a private comparison. Original routes,
 * origins, query values, source strings, and author labels never enter it.
 * Endpoint aliases are stable within the pair being compared. No free-text
 * options are copied into the report. Numeric fields and fixed labels only.
 */
export function buildComparisonMarkdown(comparison, options = {}) {
  const { maxEndpoints = 100 } = options;
  if (!Number.isInteger(maxEndpoints) || maxEndpoints < 1 || maxEndpoints > 50_000) {
    throw new Error('maxEndpoints must be an integer from 1 to 50,000.');
  }
  const baseline = comparison?.baseline || {};
  const current = comparison?.current || {};
  const delta = comparison?.delta || {};
  const counts = comparison?.counts || {};
  const thresholds = comparison?.thresholds || {};
  const endpoints = Array.isArray(comparison?.endpoints) ? comparison.endpoints : [];
  const lines = [
    '# Network recording comparison', '',
    'Generated by TraceTidy. Endpoint labels are anonymous aliases; original routes and hosts are omitted.', '',
    '## Recording summary', '',
    '| Metric | Baseline | Current | Change |',
    '| --- | --- | --- | --- |',
    `| Requests | ${finite(baseline.requestCount)} | ${finite(current.requestCount)} | ${signed(delta.requestCount)} |`,
    `| Failed requests | ${finite(baseline.failureCount)} | ${finite(current.failureCount)} | ${signed(delta.failureCount)} |`,
    `| Failure rate | ${percent(baseline.failureRate)} | ${percent(current.failureRate)} | ${signed(finite(delta.failureRate) * 100, (value) => `${value.toFixed(1)} pp`)} |`,
    `| P95 duration | ${duration(baseline.p95Ms)} | ${duration(current.p95Ms)} | ${signed(delta.p95Ms, duration)} |`,
    `| Average duration | ${duration(baseline.avgMs)} | ${duration(current.avgMs)} | ${signed(delta.avgMs, duration)} |`,
    `| Summed duration | ${duration(baseline.totalTimeMs)} | ${duration(current.totalTimeMs)} | ${signed(delta.totalTimeMs, duration)} |`,
    `| Response bytes | ${size(baseline.totalBytes)} | ${size(current.totalBytes)} | ${signed(delta.totalBytes, size)} |`, '',
    `- Regressed endpoints: ${finite(counts.regressed)}`,
    `- Improved endpoints: ${finite(counts.improved)}`,
    `- Added endpoints: ${finite(counts.added)}`,
    `- Removed endpoints: ${finite(counts.removed)}`,
    `- Unchanged endpoints: ${finite(counts.unchanged)}`, '',
    '## Endpoint comparison', '',
    'Matched by exact method, origin, and path; queries and fragments are ignored. Anonymous endpoint numbers identify the same group in both recordings.', '',
  ];
  if (endpoints.length) {
    lines.push('| Endpoint | Method | Result | Requests (before → after) | Failures (before → after) | Failure rate (before → after) | P95 (before → after) | P95 change | Average (before → after) | Summed duration (before → after) | Response bytes (before → after) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [index, endpoint] of endpoints.slice(0, maxEndpoints).entries()) {
      // Reconstruct aliases from the bounded numeric suffix only. Even a caller
      // supplying a fabricated comparison cannot inject original strings.
      const match = typeof endpoint.id === 'string' ? endpoint.id.match(/^endpoint-([1-9]\d{0,5})$/) : null;
      const alias = `endpoint-${match ? Number(match[1]) : index + 1}`;
      const method = METHODS.has(endpoint.method) ? endpoint.method : 'OTHER';
      const classification = CLASSIFICATIONS.includes(endpoint.classification) ? endpoint.classification : 'unchanged';
      const before = endpoint.baseline;
      const after = endpoint.current;
      const pair = (key, format = (value) => String(finite(value))) => `${before ? format(before[key]) : '—'} → ${after ? format(after[key]) : '—'}`;
      lines.push(`| ${alias} | ${method} | ${classification} | ${pair('count')} | ${pair('failures')} | ${pair('failureRate', percent)} | ${pair('p95Ms', duration)} | ${latencyDelta(endpoint)} | ${pair('avgMs', duration)} | ${pair('totalTimeMs', duration)} | ${pair('totalBytes', size)} |`);
    }
    if (endpoints.length > maxEndpoints) lines.push('', `Showing ${maxEndpoints} of ${endpoints.length} endpoint groups.`);
  } else lines.push('No endpoints were recorded.');
  lines.push('', '## Interpretation', '',
    `A matched endpoint regresses when P95 rises by at least ${duration(thresholds.latencyMs)} and ${finite(thresholds.latencyPercent)}% of baseline P95, or when its failure rate increases. Improvements use the same latency thresholds against the baseline. Regression evidence wins when metrics move in different directions.`, '',
    'Compare recordings of the same workflow under similar conditions. Different sample sizes, cache state, and network conditions can change results. These are recorded differences, not a diagnosis or a statistical significance test.', '',
    'Failures include HTTP 4xx/5xx and status 0. P95 uses nearest rank over normalized durations. Missing total time uses recorded phases, excluding SSL overlap; completely unknown durations become 0 and can understate latency. A zero baseline has no relative percentage change.', '',
    'Response bytes use bodySize when available, otherwise content.size. Summed duration includes overlapping requests and is not wall-clock duration. Added and removed endpoint groups have no paired latency evidence.', '');
  return lines.join('\n');
}
