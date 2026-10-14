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
  for (const operation of [() => processor.load(''), () => processor.redact(), () => processor.bundle()]) {
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
