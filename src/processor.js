/**
 * One in-memory worker per local trace. Replacing or clearing a trace terminates
 * its worker, releasing its source and rejecting results that can no longer be
 * displayed. There is deliberately no main-thread processing fallback.
 */

const WORKER_URL = new URL('./trace-worker.js', import.meta.url);
const WORKER_OPTIONS = { type: 'module' };
const UNAVAILABLE = 'Trace processing needs Web Workers. Use a modern browser or the TraceTidy CLI.';

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function abortError() {
  return namedError('AbortError', 'This operation was replaced or the local session was cleared.');
}

function defaultWorkerFactory(url, options) {
  if (typeof globalThis.Worker !== 'function') throw namedError('WorkerUnavailableError', UNAVAILABLE);
  return new Worker(url, options);
}

const REMOTE_ERRORS = new Set([
  'TraceValidationError', 'RedactionError', 'NoTraceError', 'NoSnapshotError',
  'TraceProcessingError', 'WorkerMessageError',
]);

export class TraceProcessor {
  constructor({ workerFactory = defaultWorkerFactory } = {}) {
    this._workerFactory = workerFactory;
    this._worker = null;
    this._pending = new Map();
    this._nextRequestId = 1;
    this._generation = 0;
    this._disposed = false;
    this._hasLoad = false;
    this._hasTrace = false;
    this._hasSnapshot = false;
    this._ensureWorker();
  }

  /** Load text once; a later load invalidates every earlier operation. */
  load(source) {
    if (this._disposed) return this._disposedPromise();
    if (this._hasLoad) this._reset(abortError());
    this._hasLoad = true;
    this._hasTrace = false;
    this._hasSnapshot = false;
    if (typeof source !== 'string') {
      return Promise.reject(namedError('TraceValidationError', 'Choose a HAR JSON file to load as text.'));
    }
    return this._request('load', { source });
  }

  /** Rebuild the share version using only the HAR already held by the worker. */
  redact(options = {}) {
    if (this._disposed) return this._disposedPromise();
    this._hasSnapshot = false;
    this._cancelKinds(new Set(['redact', 'bundle']));
    if (!this._hasTrace) {
      return Promise.reject(namedError('NoTraceError', 'Import a HAR recording before changing its sharing rules.'));
    }
    const { customTerms = [], preserveRoutes = false, reportDetails = {} } = options && typeof options === 'object' && !Array.isArray(options) ? options : { customTerms: null };
    return this._request('redact', { options: { customTerms, preserveRoutes, reportDetails } });
  }

  /** Create a ZIP from the worker's current successful share snapshot. */
  bundle() {
    if (this._disposed) return this._disposedPromise();
    if (!this._hasSnapshot) {
      return Promise.reject(namedError('NoSnapshotError', 'Wait for a successful share preview before downloading a share pack.'));
    }
    return this._request('bundle');
  }

  /** Release all cached trace data. The next load starts a fresh worker. */
  clear() {
    if (!this._disposed) this._reset(abortError());
  }

  /** Idempotent final cleanup; subsequent operations reject. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._reset(abortError());
  }

  _disposedPromise() {
    return Promise.reject(namedError('ProcessorDisposedError', 'This trace processor has been disposed. Create a new processor to load a recording.'));
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    let worker;
    try {
      worker = this._workerFactory(WORKER_URL, { ...WORKER_OPTIONS });
      if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') {
        throw new Error('Invalid worker interface');
      }
    } catch {
      try { worker?.terminate(); } catch { /* Best-effort startup cleanup. */ }
      throw namedError('WorkerUnavailableError', UNAVAILABLE);
    }
    this._worker = worker;
    const generation = this._generation;
    const isCurrent = () => !this._disposed && this._worker === worker && this._generation === generation;
    worker.onmessage = (event) => {
      if (isCurrent()) this._receive(event.data);
    };
    worker.onerror = (event) => {
      if (!isCurrent()) return;
      event?.preventDefault?.();
      this._reset(namedError('WorkerError', 'The trace worker stopped unexpectedly. Import the recording again to retry.'));
    };
    worker.onmessageerror = () => {
      if (isCurrent()) this._reset(namedError('WorkerMessageError', 'The trace worker could not exchange data. Import the recording again to retry.'));
    };
    return worker;
  }

  _request(kind, fields = {}) {
    let worker;
    try {
      worker = this._ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = this._nextRequestId++;
    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { kind, resolve, reject });
      try {
        worker.postMessage({ requestId, kind, ...fields });
      } catch {
        // A failed clone or send must not leave a promise or cached export alive.
        this._reset(namedError('WorkerMessageError', 'The trace worker could not receive this operation. Import the recording again to retry.'));
      }
    });
  }

  _receive(message) {
    if (!message || !Number.isSafeInteger(message.requestId)) {
      this._reset(namedError('WorkerMessageError', 'The trace worker returned an invalid response. Import the recording again to retry.'));
      return;
    }
    const pending = this._pending.get(message.requestId);
    // Replies from cancelled redactions and terminated workers never reach UI.
    if (!pending) return;
    if (typeof message.ok !== 'boolean') {
      this._reset(namedError('WorkerMessageError', 'The trace worker returned an invalid response. Import the recording again to retry.'));
      return;
    }
    this._pending.delete(message.requestId);
    if (!message.ok) {
      const error = message.error;
      const safe = error && REMOTE_ERRORS.has(error.name) && typeof error.message === 'string';
      if (pending.kind === 'load') this._hasTrace = false;
      if (pending.kind !== 'bundle') this._hasSnapshot = false;
      pending.reject(namedError(safe ? error.name : 'TraceProcessingError', safe ? error.message : 'The recording could not be processed. Export a fresh HAR and try again.'));
      return;
    }
    if (pending.kind === 'load') this._hasTrace = true;
    if (pending.kind === 'load' || pending.kind === 'redact') this._hasSnapshot = true;
    pending.resolve(message.payload);
  }

  _cancelKinds(kinds) {
    for (const [requestId, pending] of this._pending) {
      if (!kinds.has(pending.kind)) continue;
      this._pending.delete(requestId);
      pending.reject(abortError());
    }
  }

  _reset(error) {
    this._generation += 1;
    const worker = this._worker;
    this._worker = null;
    this._hasLoad = false;
    this._hasTrace = false;
    this._hasSnapshot = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* The promises still settle below. */ }
    }
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
  }
}
