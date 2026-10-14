import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTraces, buildComparisonMarkdown } from '../src/compare.js';

function request(options = {}) {
  const { url, method, time, status, bodySize, size, timings } = {
    url: 'https://api.example.com/tasks', method: 'GET', time: 100, status: 200,
    bodySize: 100, size: 200, timings: {}, ...options,
  };
  return { request: { url, method }, response: { status, bodySize, content: { size } }, time, timings };
}

const trace = (entries) => ({ log: { entries } });
const endpoint = (result, path) => result.endpoints.find((item) => item.path === path);

test('matching ignores queries, fragments, and credentials while keeping method, origin and exact path', () => {
  const baseline = trace([request({ url: 'https://user:password@api.example.com/tasks?token=BEFORE#private' })]);
  const current = trace([
    request({ url: 'https://api.example.com/tasks?token=AFTER', method: 'get' }),
    request({ method: 'POST' }), request({ url: 'http://api.example.com/tasks' }),
    request({ url: 'https://api.example.com:8443/tasks' }), request({ url: 'https://api.example.com/tasks/' }),
  ]);
  const result = compareTraces(baseline, current);
  assert.deepEqual(result.counts, { added: 4, removed: 0, regressed: 0, improved: 0, unchanged: 1 });
  const matched = result.endpoints.find((item) => item.classification === 'unchanged');
  assert.equal(matched.url, 'https://api.example.com/tasks');
  assert.deepEqual(matched.baselineIndices, [0]);
  assert.deepEqual(matched.currentIndices, [0]);
  assert.ok(!JSON.stringify(result).includes('password'));
  assert.ok(!JSON.stringify(result).includes('AFTER'));
});

test('classification keeps added and removed groups distinct and prioritizes failures over latency improvements', () => {
  const result = compareTraces(trace([
    request({ url: 'https://api.example.com/regressed', time: 500 }),
    request({ url: 'https://api.example.com/improved', time: 500, status: 500 }),
    request({ url: 'https://api.example.com/unchanged', time: 500 }),
    request({ url: 'https://api.example.com/removed', time: 500 }),
  ]), trace([
    request({ url: 'https://api.example.com/regressed', time: 100, status: 0 }),
    request({ url: 'https://api.example.com/improved', time: 500, status: 200 }),
    request({ url: 'https://api.example.com/unchanged', time: 550 }),
    request({ url: 'https://api.example.com/added', time: 9000, status: 503 }),
  ]));
  assert.deepEqual(result.counts, { added: 1, removed: 1, regressed: 1, improved: 1, unchanged: 1 });
  assert.deepEqual(endpoint(result, '/regressed').reasons, ['failure-rate-regression', 'p95-improvement']);
  assert.deepEqual(endpoint(result, '/improved').reasons, ['failure-rate-improvement']);
  assert.equal(endpoint(result, '/added').baseline, null);
  assert.equal(endpoint(result, '/removed').current, null);
  assert.deepEqual(result.endpoints.map((item) => item.classification), ['regressed', 'added', 'removed', 'improved', 'unchanged']);
});

test('latency classification uses nearest-rank P95 rather than average or request count', () => {
  const baseline = trace(Array.from({ length: 20 }, (_, index) => request({ time: index === 19 ? 5000 : 100 })));
  const current = trace(Array.from({ length: 20 }, (_, index) => request({ time: index === 19 ? 0 : 200 })));
  const result = compareTraces(baseline, current);
  const group = result.endpoints[0];
  assert.equal(group.baseline.p95Ms, 100);
  assert.equal(group.current.p95Ms, 200);
  assert.ok(group.current.avgMs < group.baseline.avgMs);
  assert.equal(group.classification, 'regressed');
  assert.deepEqual(group.reasons, ['p95-regression']);
  assert.equal(group.delta.p95Ms, 100);
  assert.equal(group.delta.p95MsPercent, 100);
});

test('latency requires both thresholds with inclusive boundaries and uses baseline denominator for improvements', () => {
  const compare = (before, after, options) => compareTraces(trace([request({ time: before })]), trace([request({ time: after })]), options).endpoints[0];
  assert.equal(compare(100, 199).classification, 'unchanged');
  assert.equal(compare(1000, 1199).classification, 'unchanged');
  assert.equal(compare(500, 600).classification, 'regressed');
  assert.equal(compare(500, 400).classification, 'improved');
  assert.equal(compare(1000, 850).classification, 'unchanged');
  assert.equal(compare(500, 650, { latencyMs: 200, latencyPercent: 10 }).classification, 'unchanged');
  assert.equal(compare(500, 650, { latencyMs: 150, latencyPercent: 30 }).classification, 'regressed');
  assert.equal(compare(100, 100, { latencyMs: 0, latencyPercent: 0 }).classification, 'unchanged');
});

test('failure-rate comparisons use fractions rather than raw error counts or volume changes', () => {
  const baseline = trace([request({ status: 500 }), request()]);
  const sameRate = trace([request({ status: 500 }), request({ status: 404 }), request(), request()]);
  const result = compareTraces(baseline, sameRate);
  assert.equal(result.endpoints[0].classification, 'unchanged');
  assert.equal(result.endpoints[0].delta.failures, 1);
  assert.equal(result.endpoints[0].delta.count, 2);
  assert.equal(result.endpoints[0].delta.failureRate, 0);
  const reducedCount = compareTraces(trace([request({ status: 500 }), request(), request(), request()]), trace([request({ status: 0 }), request()]));
  assert.equal(reducedCount.endpoints[0].classification, 'regressed');
  assert.equal(reducedCount.endpoints[0].delta.failures, 0);
  assert.equal(reducedCount.endpoints[0].delta.failureRate, 0.25);
});

test('metrics normalize unavailable timings and status, preserve explicit zero, exclude SSL overlap, and use size fallback', () => {
  const baseline = trace([
    request({ time: undefined, status: undefined, bodySize: -1, size: 200, timings: { wait: 150, receive: 50, ssl: 500 } }),
    request({ time: 0, bodySize: 0, size: 1000, timings: { wait: 500 } }),
    request({ time: NaN, status: '200', bodySize: NaN, size: 300 }),
  ]);
  const result = compareTraces(baseline, trace([]));
  assert.deepEqual(result.baseline, {
    requestCount: 3, failureCount: 2, failureRate: 2 / 3,
    avgMs: 200 / 3, p95Ms: 200, totalTimeMs: 200, totalBytes: 500,
  });
  assert.equal(result.delta.requestCount, -3);
  assert.equal(result.delta.failureCount, -2);
  assert.equal(result.delta.totalBytes, -500);
  assert.equal(result.endpoints[0].baseline.failureRate, 2 / 3);
});

test('zero baselines and tiny durations keep percentages JSON-safe and expose absent relative change', () => {
  const result = compareTraces(trace([request({ time: 0, bodySize: 0 })]), trace([request({ time: 100, bodySize: 400 })]));
  assert.equal(result.endpoints[0].classification, 'regressed');
  assert.equal(result.endpoints[0].delta.p95MsPercent, null);
  assert.equal(result.delta.totalBytesPercent, null);
  const tiny = compareTraces(trace([request({ time: Number.MIN_VALUE })]), trace([request({ time: 100 })]));
  assert.ok(Number.isFinite(tiny.endpoints[0].delta.p95MsPercent));
  assert.doesNotThrow(() => JSON.stringify(tiny));
});

test('empty and malformed traces compare safely and unsupported URLs do not leak source strings', () => {
  for (const value of [null, undefined, {}, { log: null }, { log: { entries: 'wrong' } }, trace([])]) {
    const result = compareTraces(value, value);
    assert.equal(result.baseline.requestCount, 0);
    assert.equal(result.current.failureRate, 0);
    assert.deepEqual(result.endpoints, []);
    assert.ok(buildComparisonMarkdown(result).includes('No endpoints were recorded.'));
  }
  const result = compareTraces(trace([request({ url: 'not a URL?private=SECRET' })]), trace([request({ url: 'javascript:PRIVATE' })]));
  assert.equal(result.endpoints.length, 1);
  assert.equal(result.endpoints[0].classification, 'unchanged');
  assert.equal(result.endpoints[0].url, '');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('comparison does not mutate HAR input and aliases/order are deterministic even if entry order changes', () => {
  const baseline = trace([request({ url: 'https://api.example.com/b' }), request({ url: 'https://api.example.com/a' })]);
  const current = trace([request({ url: 'https://api.example.com/b', time: 300 }), request({ url: 'https://api.example.com/a', time: 300 })]);
  const before = structuredClone([baseline, current]);
  const result = compareTraces(baseline, current);
  assert.deepEqual([baseline, current], before);
  const reversed = compareTraces(trace([...baseline.log.entries].reverse()), trace([...current.log.entries].reverse()));
  assert.deepEqual(result.endpoints.map(({ id, path, classification }) => ({ id, path, classification })), reversed.endpoints.map(({ id, path, classification }) => ({ id, path, classification })));
  result.endpoints[0].baselineIndices.push(99);
  result.endpoints[0].baseline.count = 1000;
  assert.deepEqual([baseline, current], before);
});

test('Markdown always anonymizes even raw private comparisons and rejects caller text injection', () => {
  const baseline = trace([request({ url: 'https://SecretCustomer.example.com/PrivateProject?token=SECRET_TOKEN', method: 'PRIVATE_METHOD' })]);
  const current = trace([request({ url: 'https://SecretCustomer.example.com/PrivateProject?token=SECRET_TOKEN', method: 'PRIVATE_METHOD', time: 400, status: 500 })]);
  const comparison = compareTraces(baseline, current);
  assert.ok(comparison.endpoints[0].url.includes('PrivateProject'));
  const markdown = buildComparisonMarkdown(comparison, { title: 'PrivateProject', notes: 'SECRET_TOKEN', labels: { 'endpoint-1': 'PrivateProject' } });
  for (const privateTerm of ['SecretCustomer', 'PrivateProject', 'SECRET_TOKEN', 'PRIVATE_METHOD', 'https://']) assert.ok(!markdown.includes(privateTerm));
  assert.ok(markdown.includes('endpoint-1'));
  assert.ok(markdown.includes('OTHER'));
  assert.ok(markdown.includes('+300 ms (+300.0%)'));
  assert.ok(markdown.includes('100.0 pp'));
  comparison.endpoints[0].id = 'https://PrivateProject.example.com';
  comparison.endpoints[0].method = '|PRIVATE_METHOD|';
  comparison.endpoints[0].classification = 'SECRET_TOKEN';
  comparison.thresholds.latencyMs = 'PrivateProject';
  assert.ok(!buildComparisonMarkdown(comparison).includes('PrivateProject'));
  assert.ok(!buildComparisonMarkdown(comparison).includes('PRIVATE_METHOD'));
  assert.ok(!buildComparisonMarkdown(comparison).includes('SECRET_TOKEN'));
});

test('Markdown includes metric pairs, bounds endpoint count, and marks unavailable pairs', () => {
  const comparison = compareTraces(trace([request({ url: 'https://api.example.com/removed' })]), trace([request({ url: 'https://api.example.com/added', time: 300 })]));
  const markdown = buildComparisonMarkdown(comparison, { maxEndpoints: 1 });
  assert.ok(markdown.includes('Showing 1 of 2 endpoint groups.'));
  assert.ok(markdown.includes('— → 300 ms'));
  assert.ok(markdown.includes('Summed duration'));
  assert.ok(markdown.includes('Response bytes'));
  assert.ok(markdown.includes('same workflow'));
});

test('invalid thresholds and report limits fail with actionable errors', () => {
  for (const value of [-1, NaN, Infinity, '100']) {
    assert.throws(() => compareTraces(trace([]), trace([]), { latencyMs: value }), /latencyMs must be a finite, nonnegative number/);
    assert.throws(() => compareTraces(trace([]), trace([]), { latencyPercent: value }), /latencyPercent must be a finite, nonnegative number/);
  }
  for (const value of [0, -1, 1.5, '10', 50_001]) assert.throws(() => buildComparisonMarkdown({}, { maxEndpoints: value }), /maxEndpoints must be an integer/);
});
