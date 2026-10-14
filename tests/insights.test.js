import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeTrace } from '../src/insights.js';
import { sanitizeHar } from '../src/har.js';

function request(options = {}) {
  const { url, method, time, status, wait, receive, bodySize, size } = {
    url: 'https://api.example.com/tasks', method: 'GET', time: 100, status: 200,
    wait: 70, receive: 10, bodySize: 100, size: 200, ...options,
  };
  return { request: { url, method }, response: { status, bodySize, content: { size } }, time, timings: { wait, receive } };
}

const trace = (entries) => ({ log: { entries } });
const finding = (result, id) => result.findings.find((item) => item.id === id);

test('endpoint groups ignore query and fragments but preserve method, origin, and path', () => {
  const result = analyzeTrace(trace([
    request({ url: 'https://user:password@api.example.com/tasks?token=ONE#first', time: 300 }),
    request({ url: 'https://api.example.com/tasks?token=TWO', method: 'get', time: 100 }),
    request({ url: 'https://api.example.com/tasks?token=THREE', time: 200 }),
    request({ method: 'POST', time: 400 }),
    request({ url: 'http://api.example.com/tasks', time: 500 }),
    request({ url: 'https://api.example.com:8443/tasks', time: 600 }),
    request({ url: 'https://api.example.com/tasks/', time: 700 }),
  ]));
  assert.equal(result.endpoints.length, 5);
  const repeated = result.endpoints.find((endpoint) => endpoint.count === 3);
  assert.equal(repeated.url, 'https://api.example.com/tasks');
  assert.equal(repeated.host, 'api.example.com');
  assert.equal(repeated.path, '/tasks');
  assert.equal(repeated.method, 'GET');
  assert.deepEqual(repeated.indices, [0, 1, 2]);
  assert.equal(repeated.totalTimeMs, 600);
  assert.equal(repeated.avgMs, 200);
  assert.equal(repeated.p95Ms, 300);
  assert.equal(repeated.totalBytes, 300);
  assert.deepEqual(repeated.statuses, { 200: 3 });
  assert.deepEqual(finding(result, 'repeated-requests'), {
    id: 'repeated-requests', severity: 'info', count: 3, indices: [0, 1, 2],
    metrics: { endpointCount: 1, maxCount: 3, slowestMs: 300 },
  });
  for (const endpoint of result.endpoints) assert.ok(!/[?#]|ONE|TWO|THREE|password|user:/.test(endpoint.url));
});

test('P95 uses nearest rank over normalized durations with missing or non-finite times as zero', () => {
  const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 100);
  const result = analyzeTrace(trace([...values.map((time) => request({ time })),
    ...[undefined, NaN, Infinity, '10000'].map((time) => ({ ...request({ time }), timings: {} })),
  ]));
  assert.equal(result.stats.p95Ms, 1900);
  assert.equal(result.stats.slowRequests, 11);
  assert.equal(result.endpoints[0].p95Ms, 1900);
  assert.equal(result.endpoints[0].avgMs, 875);
  assert.equal(result.endpoints[0].totalTimeMs, 21000);
  assert.equal(analyzeTrace(trace([request({ time: 9 })])).stats.p95Ms, 9);
});

test('P95 and average remain consistent after strict exports normalize unknown durations to zero', () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    request: { method: 'GET', url: 'https://api.example.com/tasks' },
    response: { status: 200 },
    ...(index === 19 ? { time: 1000 } : {}),
  }));
  const source = trace(entries);
  const original = analyzeTrace(source);
  const sanitized = analyzeTrace(sanitizeHar(source).har);
  assert.equal(original.stats.p95Ms, 0);
  assert.equal(original.endpoints[0].avgMs, 50);
  assert.deepEqual(sanitized.stats, original.stats);
  assert.equal(sanitized.endpoints[0].p95Ms, original.endpoints[0].p95Ms);
  assert.equal(sanitized.endpoints[0].avgMs, original.endpoints[0].avgMs);
  assert.equal(sanitized.endpoints[0].totalTimeMs, original.endpoints[0].totalTimeMs);
});

test('HTTP observations normalize status consistently and retain original indices', () => {
  const result = analyzeTrace(trace([
    request({ status: 0 }), request({ status: 399 }), request({ status: 400 }),
    request({ status: 499.9 }), request({ status: 500 }), request({ status: 600 }),
    request({ status: '503' }), request({ status: -1 }),
  ]));
  assert.equal(result.stats.failureRate, 7 / 8);
  assert.deepEqual(finding(result, 'network-errors').indices, [0, 6, 7]);
  assert.equal(finding(result, 'network-errors').severity, 'error');
  assert.deepEqual(finding(result, 'status-4xx').indices, [2, 3]);
  assert.equal(finding(result, 'status-4xx').severity, 'warning');
  assert.deepEqual(finding(result, 'status-4xx').metrics.statuses, { 400: 1, 499: 1 });
  assert.deepEqual(finding(result, 'status-5xx').indices, [4, 5]);
  assert.equal(finding(result, 'status-5xx').severity, 'error');
  assert.deepEqual(finding(result, 'status-5xx').metrics.statuses, { 500: 1, 599: 1 });
  assert.equal(result.endpoints[0].failures, 7);
});

test('missing total time uses recorded phases, excludes SSL overlap, and keeps explicit zero', () => {
  const source = { ...request({ time: undefined }), timings: { send: 10, wait: 2000, receive: 100, ssl: 800 } };
  const result = analyzeTrace(trace([source]));
  assert.equal(result.stats.slowRequests, 1);
  assert.equal(result.stats.p95Ms, 2110);
  assert.equal(result.endpoints[0].avgMs, 2110);
  assert.equal(result.endpoints[0].totalTimeMs, 2110);
  assert.equal(finding(result, 'slow-ttfb').count, 1);
  const zero = analyzeTrace(trace([{ ...source, time: 0 }]));
  assert.equal(zero.stats.slowRequests, 0);
  assert.equal(zero.stats.p95Ms, 0);
  assert.equal(zero.endpoints[0].totalTimeMs, 0);
});

test('timing observations require both a slow total and a recorded phase share', () => {
  const result = analyzeTrace(trace([
    request({ time: 999, wait: 999, receive: 999 }),
    request({ time: 1000, wait: 700, receive: 499 }),
    request({ time: 1000, wait: 699, receive: 500 }),
    request({ time: 2000, wait: 1400, receive: 1000 }),
    request({ time: 1000, wait: undefined, receive: undefined }),
    request({ time: 1000, wait: -1, receive: NaN }),
    request({ time: 1000, wait: '1000', receive: Infinity }),
  ]));
  assert.equal(result.stats.slowRequests, 6);
  assert.deepEqual(finding(result, 'slow-ttfb').indices, [1, 3]);
  assert.equal(finding(result, 'slow-ttfb').metrics.maxWaitMs, 1400);
  assert.equal(finding(result, 'slow-ttfb').metrics.maxWaitShare, 0.7);
  assert.deepEqual(finding(result, 'slow-download').indices, [2, 3]);
  assert.equal(finding(result, 'slow-download').metrics.maxReceiveMs, 1000);
  assert.equal(finding(result, 'slow-download').metrics.maxReceiveShare, 0.5);
  assert.equal(finding(result, 'slow-download').metrics.slowestMs, 2000);
});

test('repetition requires at least three requests and aggregates qualifying groups', () => {
  const result = analyzeTrace(trace([
    request(), request({ url: 'https://api.example.com/other' }), request(),
    request({ url: 'https://api.example.com/other' }), request(),
    request({ url: 'https://api.example.com/other' }), request({ url: 'https://api.example.com/other' }),
    request({ method: 'POST' }), request({ method: 'POST' }),
  ]));
  const repeated = finding(result, 'repeated-requests');
  assert.equal(repeated.count, 7);
  assert.deepEqual(repeated.indices, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(repeated.metrics.endpointCount, 2);
  assert.equal(repeated.metrics.maxCount, 4);
});

test('response size accounting uses bodySize with content.size fallback and finite bounds', () => {
  const result = analyzeTrace(trace([
    request({ bodySize: 0, size: 400 }), request({ bodySize: -1, size: 200 }),
    request({ bodySize: undefined, size: 300 }), request({ bodySize: NaN, size: 400 }),
    request({ bodySize: -30, size: -5 }), request({ bodySize: Infinity, size: Infinity }),
  ]));
  assert.equal(result.endpoints[0].totalBytes, 900);
  const bounded = analyzeTrace(trace([request({ bodySize: Number.MAX_SAFE_INTEGER }), request({ bodySize: Number.MAX_SAFE_INTEGER })]));
  assert.equal(bounded.endpoints[0].totalBytes, Number.MAX_SAFE_INTEGER);
});

test('empty, malformed, and invalid-URL traces return safe structures without inferred repetition', () => {
  for (const input of [null, undefined, {}, { log: null }, { log: { entries: 'wrong' } }, trace([])]) {
    assert.deepEqual(analyzeTrace(input), { stats: { slowRequests: 0, failureRate: 0, p95Ms: 0 }, findings: [], endpoints: [] });
  }
  const result = analyzeTrace(trace([null, {}, request({ url: 'not a URL?private=secret' }), request({ url: 'javascript:alert(1)' })]));
  assert.equal(result.endpoints.length, 2);
  assert.ok(!finding(result, 'repeated-requests'));
  for (const endpoint of result.endpoints) {
    assert.equal(endpoint.url, '');
    assert.equal(endpoint.host, '');
    assert.equal(endpoint.path, '/');
  }
  for (const value of Object.values(result.stats)) assert.ok(Number.isFinite(value));
});

test('analysis does not mutate source values and endpoint order is stable on ties', () => {
  const entries = [request({ url: 'https://api.example.com/b', time: 400 }), request({ time: 400 })];
  const source = trace(entries);
  const before = structuredClone(source);
  const result = analyzeTrace(source);
  assert.deepEqual(source, before);
  assert.deepEqual(result.endpoints.map((endpoint) => endpoint.path), ['/b', '/tasks']);
  result.endpoints[0].indices.push(99);
  result.endpoints[0].statuses[500] = 1;
  assert.deepEqual(source, before);
});

test('synthetic sample and large traces analyze with finite output without date fields', async () => {
  const sample = JSON.parse(await readFile(new URL('../samples/demo.har', import.meta.url), 'utf8'));
  const result = analyzeTrace(sample);
  assert.ok(result.endpoints.length > 0);
  assert.ok(result.findings.length > 0);
  const large = analyzeTrace(trace(Array.from({ length: 50_000 }, (_, index) => request({ url: `https://api.example.com/${index % 100}?index=${index}`, time: index % 2000 }))));
  assert.equal(large.endpoints.length, 100);
  assert.equal(large.endpoints.reduce((sum, endpoint) => sum + endpoint.count, 0), 50_000);
  assert.equal(finding(large, 'repeated-requests').count, 50_000);
  assert.ok(Number.isFinite(large.stats.p95Ms));
});
