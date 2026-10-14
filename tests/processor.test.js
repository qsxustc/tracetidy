import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceProcessor } from '../src/processor.js';
import { createTraceWorkerHandler } from '../src/trace-worker.js';

class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminated = false;
  }
  postMessage(message) { this.messages.push(structuredClone(message)); }
  terminate() { this.terminated = true; }
  reply(requestId, payload) { this.onmessage?.({ data: { requestId, ok: true, payload } }); }
  fail(requestId, error) { this.onmessage?.({ data: { requestId, ok: false, error } }); }
}

class ProtocolWorker extends FakeWorker {
  constructor() {
    super();
    this.handler = createTraceWorkerHandler((message) => {
      const data = structuredClone(message);
      queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data }); });
    });
  }
  postMessage(message) {
    super.postMessage(message);
    const data = structuredClone(message);
    queueMicrotask(() => { if (!this.terminated) this.handler({ data }); });
  }
}

function setup(WorkerType = FakeWorker) {
  const workers = [];
  const processor = new TraceProcessor({ workerFactory(url, options) {
    assert.ok(url.pathname.endsWith('/src/trace-worker.js'));
    assert.deepEqual(options, { type: 'module' });
    const worker = new WorkerType();
    workers.push(worker);
    return worker;
  } });
  return { processor, workers };
}

function recording() {
  return JSON.stringify({ log: { version: '1.2', entries: [{
    startedDateTime: '2026-01-01T00:00:00Z', time: 1400,
    request: { method: 'GET', url: 'https://private.example.com/account/Alice?token=SECRET_TOKEN', headers: [{ name: 'Authorization', value: 'SECRET_HEADER' }], cookies: [] },
    response: { status: 503, bodySize: 200, headers: [], cookies: [], content: { size: 200, mimeType: 'application/json', text: 'SECRET_BODY' } },
    timings: { wait: 1300, receive: 100 },
  }] } });
}

function baselineRecording() {
  const har = JSON.parse(recording());
  har.log.entries[0].time = 200;
  har.log.entries[0].response.status = 200;
  har.log.entries[0].request.url = 'https://private.example.com/account/Alice?token=BASELINE_SECRET_TOKEN';
  har.log.entries[0].request.headers[0].value = 'BASELINE_SECRET_HEADER';
  har.log.entries[0].response.content.text = 'BASELINE_SECRET_BODY';
  return JSON.stringify(har);
}

async function manualLoad(processor, worker, payload = { trace: 'loaded' }) {
  const result = processor.load('local trace text');
  worker.reply(worker.messages.at(-1).requestId, payload);
  await result;
}

function rejection(promise, name) {
  return assert.rejects(promise, (error) => error.name === name);
}

test('a later load terminates the old worker and ignores its late replies', async () => {
  const { processor, workers } = setup();
  const first = processor.load('first private recording');
  const old = workers[0];
  const staleCallback = old.onmessage;
  const firstRejected = rejection(first, 'AbortError');
  const second = processor.load('second private recording');
  assert.equal(old.terminated, true);
  assert.equal(workers.length, 2);
  staleCallback({ data: { requestId: old.messages[0].requestId, ok: true, payload: { trace: 'stale' } } });
  const current = workers[1];
  current.reply(current.messages[0].requestId, { trace: 'current' });
  assert.deepEqual(await second, { trace: 'current' });
  await firstRejected;
  processor.dispose();
});

test('only the newest redaction can resolve, including out-of-order replies', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const first = processor.redact({ customTerms: ['older'] });
  const firstRejected = rejection(first, 'AbortError');
  const second = processor.redact({ customTerms: ['current'], preserveRoutes: true, reportDetails: { title: 'Checkout failure', notes: 'Reproduction steps' } });
  const [older, current] = worker.messages.slice(-2);
  assert.deepEqual(current.options, { customTerms: ['current'], preserveRoutes: true, reportDetails: { title: 'Checkout failure', notes: 'Reproduction steps' } });
  assert.ok(!Object.hasOwn(current, 'source'));
  worker.reply(current.requestId, { safe: 'new snapshot' });
  worker.fail(older.requestId, { name: 'RedactionError', message: 'Use at most 100 custom redaction terms.' });
  assert.deepEqual(await second, { safe: 'new snapshot' });
  await firstRejected;
  const bundle = processor.bundle();
  const blob = new Blob(['current']);
  worker.reply(worker.messages.at(-1).requestId, blob);
  assert.equal(await bundle, blob);
  processor.dispose();
});

test('clear rejects pending loads, releases the worker, and restarts lazily', async () => {
  const { processor, workers } = setup();
  const load = processor.load('private recording');
  const rejected = rejection(load, 'AbortError');
  processor.clear();
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 1);
  await rejected;
  await rejection(processor.redact(), 'NoTraceError');
  await rejection(processor.bundle(), 'NoSnapshotError');
  const next = processor.load('replacement');
  workers[1].reply(workers[1].messages[0].requestId, { trace: 'replacement' });
  assert.deepEqual(await next, { trace: 'replacement' });
  processor.dispose();
});

test('clear rejects all pending ZIP downloads and stale callbacks cannot restore a session', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const downloads = [processor.bundle(), processor.bundle()];
  const rejected = downloads.map((promise) => rejection(promise, 'AbortError'));
  const staleCallback = worker.onmessage;
  processor.clear();
  for (const message of worker.messages) staleCallback({ data: { requestId: message.requestId, ok: true, payload: new Blob(['old']) } });
  await Promise.all(rejected);
  await rejection(processor.bundle(), 'NoSnapshotError');
  processor.dispose();
});

test('changing rules cancels a pending download and hides the old snapshot', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const oldBundle = processor.bundle();
  const rejected = rejection(oldBundle, 'AbortError');
  const redact = processor.redact();
  await rejection(processor.bundle(), 'NoSnapshotError');
  worker.reply(worker.messages.at(-1).requestId, { safe: 'current' });
  await redact;
  await rejected;
  processor.dispose();
});

test('dispose aborts pending work and permanently rejects further operations', async () => {
  const { processor, workers } = setup();
  await manualLoad(processor, workers[0]);
  const redact = processor.redact();
  const rejected = rejection(redact, 'AbortError');
  processor.dispose();
  processor.dispose();
  processor.clear();
  assert.equal(workers[0].terminated, true);
  await rejected;
  for (const operation of [() => processor.load(''), () => processor.redact(), () => processor.bundle(),
    () => processor.setBaseline(''), () => processor.compare(), () => processor.clearBaseline()]) {
    await rejection(operation(), 'ProcessorDisposedError');
  }
  assert.equal(workers.length, 1);
});

test('worker crashes reject every pending operation without echoing crash contents', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const bundles = [processor.bundle(), processor.bundle()];
  const errors = bundles.map((promise) => assert.rejects(promise, (error) => {
    assert.equal(error.name, 'WorkerError');
    assert.ok(!error.message.includes('SECRET_CRASH'));
    return true;
  }));
  let prevented = false;
  worker.onerror({ message: 'SECRET_CRASH', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(worker.terminated, true);
  await Promise.all(errors);
  const next = processor.load('fresh recording');
  workers[1].reply(workers[1].messages[0].requestId, { trace: 'fresh' });
  await next;
  processor.dispose();
});

test('message failures and invalid worker replies settle pending requests', async () => {
  for (const trigger of [
    (worker) => worker.onmessageerror({ data: 'SECRET_MESSAGE' }),
    (worker) => worker.onmessage({ data: null }),
    (worker) => worker.onmessage({ data: { requestId: worker.messages[0].requestId, ok: 'invalid' } }),
  ]) {
    const { processor, workers } = setup();
    const load = processor.load('private input');
    const rejected = rejection(load, 'WorkerMessageError');
    trigger(workers[0]);
    await rejected;
    assert.equal(workers[0].terminated, true);
    processor.dispose();
  }
});

test('an unclonable request settles instead of hanging and destroys stale caches', async () => {
  const { processor, workers } = setup();
  await manualLoad(processor, workers[0]);
  await rejection(processor.redact({ customTerms: [() => 'private'] }), 'WorkerMessageError');
  assert.equal(workers[0].terminated, true);
  await rejection(processor.bundle(), 'NoSnapshotError');
  processor.dispose();
});

test('worker availability errors have actionable, source-free guidance', () => {
  assert.throws(() => new TraceProcessor({ workerFactory() { throw new Error('SECRET_BROWSER_CONTEXT'); } }), (error) => {
    assert.equal(error.name, 'WorkerUnavailableError');
    assert.match(error.message, /modern browser.*CLI/);
    assert.ok(!error.message.includes('SECRET_BROWSER_CONTEXT'));
    return true;
  });
  if (typeof globalThis.Worker !== 'function') assert.throws(() => new TraceProcessor(), { name: 'WorkerUnavailableError' });
});

test('invalid and empty loads return safe errors and a fresh load recovers', async () => {
  const { processor, workers } = setup(ProtocolWorker);
  for (const source of ['', 'SECRET_INVALID_SOURCE', '{}']) {
    await assert.rejects(processor.load(source), (error) => {
      assert.equal(error.name, 'TraceValidationError');
      assert.ok(!error.message.includes('SECRET_INVALID_SOURCE'));
      return true;
    });
    await rejection(processor.bundle(), 'NoSnapshotError');
  }
  await rejection(processor.load(null), 'TraceValidationError');
  const loaded = await processor.load(recording());
  assert.equal(loaded.summary.requestCount, 1);
  assert.equal(loaded.summary.failureCount, 1);
  assert.equal(loaded.har.log.entries[0].response.content.text, 'SECRET_BODY');
  assert.ok(loaded.insights.findings.length > 0);
  assert.deepEqual(JSON.parse(loaded.harText), loaded.safe);
  assert.equal(JSON.parse(loaded.auditText).preserveRoutes, false);
  assert.equal(JSON.parse(loaded.auditText).includesAuthorNotes, false);
  for (const secret of ['SECRET_BODY', 'SECRET_HEADER', 'SECRET_TOKEN', 'private.example.com', 'Alice']) {
    for (const text of [loaded.harText, loaded.reportText, loaded.auditText]) assert.ok(!text.includes(secret), `Leaked ${secret}`);
  }
  assert.ok(workers.slice(0, -1).every((worker) => worker.terminated));
  processor.dispose();
});

function unpackStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  const decoder = new TextDecoder();
  let position = 0;
  while (view.getUint32(position, true) === 0x04034b50) {
    const size = view.getUint32(position + 18, true);
    const nameLength = view.getUint16(position + 26, true);
    const extraLength = view.getUint16(position + 28, true);
    const name = decoder.decode(bytes.slice(position + 30, position + 30 + nameLength));
    const start = position + 30 + nameLength + extraLength;
    files[name] = decoder.decode(bytes.slice(start, start + size));
    position = start + size;
  }
  assert.equal(view.getUint32(position, true), 0x02014b50);
  return files;
}

test('cached redaction and its ZIP use exactly the current policy and report snapshot', async () => {
  const { processor, workers } = setup(ProtocolWorker);
  await processor.load(recording());
  const worker = workers[0];
  const redacted = await processor.redact({ customTerms: ['Alice'], preserveRoutes: true, reportDetails: { title: 'Checkout failure', notes: 'Open cart, submit order, observe HTTP 503.' } });
  assert.equal(worker.messages.filter((message) => message.kind === 'load').length, 1);
  assert.ok(!Object.hasOwn(worker.messages.at(-1), 'source'));
  assert.ok(redacted.harText.includes('private.example.com'));
  assert.ok(!redacted.harText.includes('Alice'));
  assert.match(redacted.reportText, /^# Checkout failure/);
  assert.ok(redacted.reportText.includes('Open cart, submit order, observe HTTP 503'));
  const manifest = JSON.parse(redacted.auditText);
  assert.equal(manifest.preserveRoutes, true);
  assert.equal(manifest.includesAuthorNotes, true);
  assert.ok(!redacted.auditText.includes('Alice'));
  const blob = await processor.bundle();
  assert.equal(blob.type, 'application/zip');
  assert.deepEqual(unpackStoredZip(new Uint8Array(await blob.arrayBuffer())), {
    'safe.har': redacted.harText, 'issue.md': redacted.reportText, 'audit.json': redacted.auditText,
  });
  const reset = await processor.redact();
  assert.ok(!reset.harText.includes('private.example.com'));
  assert.equal(JSON.parse(reset.auditText).includesAuthorNotes, false);
  processor.dispose();
});

test('invalid sharing rules clear snapshots but retain the original for correction', async () => {
  const { processor, workers } = setup(ProtocolWorker);
  await processor.load(recording());
  for (const options of [
    { customTerms: 'SECRET_BAD_TERM' },
    { customTerms: [12] },
    { customTerms: ['x'.repeat(257)] },
    { reportDetails: { title: 'SECRET_TITLE'.repeat(50) } },
    { reportDetails: { notes: 'SECRET_NOTES'.repeat(1000) } },
    { reportDetails: { notes: 12 } },
    { reportDetails: null },
    null,
  ]) {
    await assert.rejects(processor.redact(options), (error) => {
      assert.equal(error.name, 'RedactionError');
      assert.ok(!/SECRET/.test(error.message));
      return true;
    });
    await rejection(processor.bundle(), 'NoSnapshotError');
  }
  const corrected = await processor.redact({ customTerms: [] });
  assert.equal(corrected.safe.log.entries.length, 1);
  assert.equal(workers.length, 1);
  processor.dispose();
});

test('worker protocol refuses ZIPs without a successful snapshot, even after policy failure', () => {
  const replies = [];
  const handler = createTraceWorkerHandler((reply) => replies.push(structuredClone(reply)));
  handler({ data: { requestId: 1, kind: 'bundle' } });
  assert.equal(replies.at(-1).error.name, 'NoSnapshotError');
  handler({ data: { requestId: 2, kind: 'load', source: recording() } });
  assert.equal(replies.at(-1).ok, true);
  handler({ data: { requestId: 3, kind: 'redact', options: { customTerms: [false] } } });
  assert.equal(replies.at(-1).error.name, 'RedactionError');
  handler({ data: { requestId: 4, kind: 'bundle' } });
  assert.equal(replies.at(-1).error.name, 'NoSnapshotError');
  handler({ data: { requestId: 5, kind: 'redact', options: {} } });
  assert.equal(replies.at(-1).ok, true);
  handler({ data: { requestId: 6, kind: 'load', source: '' } });
  assert.equal(replies.at(-1).error.name, 'TraceValidationError');
  handler({ data: { requestId: 7, kind: 'redact', options: {} } });
  assert.equal(replies.at(-1).error.name, 'NoTraceError');
});

test('empty recordings load successfully with usable share snapshots', async () => {
  const { processor } = setup(ProtocolWorker);
  const loaded = await processor.load(JSON.stringify({ log: { entries: [] } }));
  assert.equal(loaded.summary.requestCount, 0);
  assert.deepEqual(loaded.safe.log.entries, []);
  assert.ok((await processor.bundle()).size > 0);
  processor.dispose();
});

test('baseline operations require the loaded current trace and a completed baseline', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await rejection(processor.setBaseline('baseline'), 'NoTraceError');
  await rejection(processor.compare(), 'NoTraceError');
  await manualLoad(processor, worker);
  await rejection(processor.compare(), 'NoBaselineError');
  const pending = processor.setBaseline('baseline');
  await rejection(processor.compare(), 'NoBaselineError');
  worker.reply(worker.messages.at(-1).requestId, { comparison: { counts: {} }, comparisonText: 'safe report' });
  await pending;
  const comparison = processor.compare({ latencyMs: 50, latencyPercent: 10 });
  assert.deepEqual(worker.messages.at(-1).options, { latencyMs: 50, latencyPercent: 10 });
  assert.ok(!Object.hasOwn(worker.messages.at(-1), 'source'));
  worker.reply(worker.messages.at(-1).requestId, { comparison: 'current', comparisonText: 'updated' });
  assert.equal((await comparison).comparison, 'current');
  processor.dispose();
});

test('new baseline and threshold operations reject stale comparison replies without changing share flags', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const oldBaseline = processor.setBaseline('older private baseline');
  const rejectedBaseline = rejection(oldBaseline, 'AbortError');
  const latestBaseline = processor.setBaseline('current private baseline');
  const [older, current] = worker.messages.slice(-2);
  worker.reply(current.requestId, { comparison: 'current', comparisonText: 'current safe report' });
  assert.equal((await latestBaseline).comparison, 'current');
  worker.reply(older.requestId, { comparison: 'stale', comparisonText: 'stale report' });
  await rejectedBaseline;
  const first = processor.compare({ latencyMs: 100, latencyPercent: 20 });
  const rejectedFirst = rejection(first, 'AbortError');
  const second = processor.compare({ latencyMs: 500, latencyPercent: 50 });
  const [oldCompare, newCompare] = worker.messages.slice(-2);
  worker.reply(newCompare.requestId, { comparison: 'latest thresholds', comparisonText: 'latest report' });
  worker.fail(oldCompare.requestId, { name: 'ComparisonValidationError', message: 'Comparison settings must be an object with latency thresholds.' });
  assert.equal((await second).comparison, 'latest thresholds');
  await rejectedFirst;
  const bundle = processor.bundle();
  const blob = new Blob(['still available']);
  worker.reply(worker.messages.at(-1).requestId, blob);
  assert.equal(await bundle, blob);
  processor.dispose();
});

test('baseline changes cancel ZIPs and a cleared baseline cannot be restored by stale responses', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const bundle = processor.bundle();
  const rejectedBundle = rejection(bundle, 'AbortError');
  const baseline = processor.setBaseline('private baseline');
  const rejectedBaseline = rejection(baseline, 'AbortError');
  const baselineId = worker.messages.at(-1).requestId;
  const clearing = processor.clearBaseline();
  const clearId = worker.messages.at(-1).requestId;
  await rejection(processor.compare(), 'NoBaselineError');
  worker.reply(clearId, { comparison: null, comparisonText: '' });
  assert.deepEqual(await clearing, { comparison: null, comparisonText: '' });
  worker.reply(baselineId, { comparison: 'stale', comparisonText: 'stale' });
  await Promise.all([rejectedBundle, rejectedBaseline]);
  await rejection(processor.compare(), 'NoBaselineError');
  const freshBundle = processor.bundle();
  worker.reply(worker.messages.at(-1).requestId, new Blob(['share snapshot survives']));
  assert.ok((await freshBundle).size > 0);
  processor.dispose();
});

test('clear baseline cancels an active comparison and every pending ZIP', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const baseline = processor.setBaseline('baseline');
  worker.reply(worker.messages.at(-1).requestId, { comparison: {}, comparisonText: 'safe' });
  await baseline;
  const comparing = processor.compare();
  const pending = [rejection(comparing, 'AbortError')];
  pending.push(rejection(processor.bundle(), 'AbortError'), rejection(processor.bundle(), 'AbortError'));
  const clear = processor.clearBaseline();
  worker.reply(worker.messages.at(-1).requestId, { comparison: null, comparisonText: '' });
  await clear;
  await Promise.all(pending);
  await rejection(processor.compare(), 'NoBaselineError');
  processor.dispose();
});

test('a new current recording resets baseline state and aborts pending comparison operations', async () => {
  const { processor, workers } = setup();
  const worker = workers[0];
  await manualLoad(processor, worker);
  const baseline = processor.setBaseline('baseline');
  worker.reply(worker.messages.at(-1).requestId, { comparison: {}, comparisonText: 'safe' });
  await baseline;
  const comparison = processor.compare();
  const rejected = rejection(comparison, 'AbortError');
  const staleCallback = worker.onmessage;
  const comparisonId = worker.messages.at(-1).requestId;
  const nextLoad = processor.load('next current recording');
  workers[1].reply(workers[1].messages[0].requestId, { trace: 'new current' });
  await nextLoad;
  staleCallback({ data: { requestId: comparisonId, ok: true, payload: { comparison: 'stale', comparisonText: 'stale' } } });
  await rejected;
  await rejection(processor.compare(), 'NoBaselineError');
  assert.equal(worker.terminated, true);
  processor.clear();
  assert.deepEqual(await processor.clearBaseline(), { comparison: null, comparisonText: '' });
  assert.equal(workers.length, 2);
  processor.dispose();
});

test('baseline is retained only in worker cache and its safe report follows threshold changes into ZIPs', async () => {
  const { processor, workers } = setup(ProtocolWorker);
  const loaded = await processor.load(recording());
  const result = await processor.setBaseline(baselineRecording());
  assert.deepEqual(Object.keys(result).sort(), ['comparison', 'comparisonText']);
  assert.equal(result.comparison.baseline.requestCount, 1);
  assert.equal(result.comparison.baseline.failureCount, 0);
  assert.equal(result.comparison.current.failureCount, 1);
  assert.equal(result.comparison.counts.regressed, 1);
  assert.equal(result.comparison.endpoints[0].url, 'https://private.example.com/account/Alice');
  assert.ok(!JSON.stringify(result).includes('BASELINE_SECRET'));
  assert.match(result.comparisonText, /endpoint-1/);
  for (const secret of ['BASELINE_SECRET', 'SECRET_BODY', 'SECRET_HEADER', 'SECRET_TOKEN', 'private.example.com', 'Alice', '/account']) {
    assert.ok(!result.comparisonText.includes(secret), `Comparison report leaked ${secret}`);
  }
  const firstFiles = unpackStoredZip(new Uint8Array(await (await processor.bundle()).arrayBuffer()));
  assert.equal(firstFiles['comparison.md'], result.comparisonText);
  assert.equal(firstFiles['safe.har'], loaded.harText);
  const changed = await processor.compare({ latencyMs: 1700, latencyPercent: 300 });
  assert.match(changed.comparisonText, /1700 ms and 300%/);
  const changedFiles = unpackStoredZip(new Uint8Array(await (await processor.bundle()).arrayBuffer()));
  assert.equal(changedFiles['comparison.md'], changed.comparisonText);
  await processor.redact({ customTerms: ['Alice', 'endpoint'], preserveRoutes: true, reportDetails: { title: 'Custom private title', notes: 'BASELINE_SECRET_NOTE' } });
  const preservedFiles = unpackStoredZip(new Uint8Array(await (await processor.bundle()).arrayBuffer()));
  assert.equal(preservedFiles['comparison.md'], changed.comparisonText);
  assert.ok(preservedFiles['safe.har'].includes('private.example.com'));
  assert.equal(workers[0].messages.filter((message) => message.kind === 'load').length, 1);
  assert.equal(workers[0].messages.filter((message) => message.kind === 'setBaseline').length, 1);
  processor.dispose();
});

test('invalid replacement baselines clear earlier comparison exports and keep the current share snapshot usable', async () => {
  const { processor } = setup(ProtocolWorker);
  const loaded = await processor.load(recording());
  for (const source of ['', 'BASELINE_SECRET_INVALID_JSON', '{}', null, 123]) {
    await processor.setBaseline(baselineRecording());
    await assert.rejects(processor.setBaseline(source), (error) => {
      assert.equal(error.name, 'TraceValidationError');
      assert.ok(!error.message.includes('BASELINE_SECRET'));
      return true;
    });
    await rejection(processor.compare(), 'NoBaselineError');
    const files = unpackStoredZip(new Uint8Array(await (await processor.bundle()).arrayBuffer()));
    assert.ok(!Object.hasOwn(files, 'comparison.md'));
    assert.equal(files['safe.har'], loaded.harText);
  }
  processor.dispose();
});

test('invalid comparison thresholds remove stale reports while retaining the baseline for correction', async () => {
  const { processor } = setup(ProtocolWorker);
  await processor.load(recording());
  await processor.setBaseline(baselineRecording());
  for (const options of [null, [], 'SECRET_OPTIONS', { latencyMs: 'SECRET_THRESHOLD' },
    { latencyMs: -1 }, { latencyPercent: Infinity }, { latencyMs: 30 * 24 * 60 * 60 * 1000 + 1 },
    { latencyPercent: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(processor.compare(options), (error) => {
      assert.equal(error.name, 'ComparisonValidationError');
      assert.ok(!error.message.includes('SECRET'));
      return true;
    });
    const files = unpackStoredZip(new Uint8Array(await (await processor.bundle()).arrayBuffer()));
    assert.ok(!Object.hasOwn(files, 'comparison.md'));
    const corrected = await processor.compare({ latencyMs: 200, latencyPercent: 40 });
    assert.equal(corrected.comparison.baseline.requestCount, 1);
    assert.equal(corrected.comparison.thresholds.latencyMs, 200);
  }
  processor.dispose();
});

test('clearing or loading another current recording excludes the previous comparison from ZIPs', async () => {
  const { processor } = setup(ProtocolWorker);
  await processor.load(recording());
  await processor.setBaseline(baselineRecording());
  assert.deepEqual(await processor.clearBaseline(), { comparison: null, comparisonText: '' });
  await rejection(processor.compare(), 'NoBaselineError');
  let files = unpackStoredZip(new Uint8Array(await (await processor.bundle()).arrayBuffer()));
  assert.ok(!Object.hasOwn(files, 'comparison.md'));
  await processor.setBaseline(baselineRecording());
  await processor.load(recording());
  await rejection(processor.compare(), 'NoBaselineError');
  files = unpackStoredZip(new Uint8Array(await (await processor.bundle()).arrayBuffer()));
  assert.ok(!Object.hasOwn(files, 'comparison.md'));
  processor.dispose();
});

test('worker protocol clears baseline and report before a failed replacement and current load', () => {
  const replies = [];
  const handler = createTraceWorkerHandler((reply) => replies.push(structuredClone(reply)));
  const send = (requestId, kind, fields = {}) => {
    handler({ data: { requestId, kind, ...fields } });
    return replies.at(-1);
  };
  assert.equal(send(1, 'compare', { options: {} }).error.name, 'NoTraceError');
  assert.equal(send(2, 'setBaseline', { source: baselineRecording() }).error.name, 'NoTraceError');
  assert.equal(send(3, 'load', { source: recording() }).ok, true);
  assert.equal(send(4, 'compare', { options: {} }).error.name, 'NoBaselineError');
  assert.equal(send(5, 'setBaseline', { source: baselineRecording() }).ok, true);
  assert.equal(send(6, 'setBaseline', { source: 'SECRET_INVALID_BASELINE' }).error.name, 'TraceValidationError');
  assert.equal(send(7, 'compare', { options: {} }).error.name, 'NoBaselineError');
  assert.equal(send(8, 'setBaseline', { source: baselineRecording() }).ok, true);
  assert.equal(send(9, 'load', { source: '' }).error.name, 'TraceValidationError');
  assert.equal(send(10, 'compare', { options: {} }).error.name, 'NoTraceError');
  assert.equal(send(11, 'load', { source: recording() }).ok, true);
  assert.equal(send(12, 'compare', { options: {} }).error.name, 'NoBaselineError');
});
