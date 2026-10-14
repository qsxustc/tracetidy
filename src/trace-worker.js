import { validateHar, summarizeHar, sanitizeHar, buildReport } from './har.js';
import { analyzeTrace } from './insights.js';
import { compareTraces, buildComparisonMarkdown } from './compare.js';
import { createZip } from './zip.js';

// Only these core messages are safe to return. Native parser/worker errors can
// contain source excerpts, filenames, or values and must never be echoed.
const SAFE_CORE_MESSAGES = new Set([
  'HAR input must contain JSON data without circular references. Export a fresh HAR file from your browser.',
  'Choose a HAR JSON file or pass a HAR object with log.entries.',
  'The HAR file is empty. Export a network recording from your browser first.',
  'The HAR file exceeds the 50 MB text limit. Export a shorter network recording.',
  'The file is not valid JSON. Export a HAR file from the Network panel, then try again.',
  'This JSON is missing log.entries. Export a HAR file from your browser’s Network panel.',
  'This HAR contains more than 50,000 requests. Export a shorter recording.',
  'customTerms must be an array of words or phrases to redact.',
  'Use at most 100 custom redaction terms.',
  'Each custom redaction term must be a string.',
  'Each custom redaction term must be at most 256 characters.',
  'A custom term conflicts with a structural HAR value. Use a more specific private term.',
  'Report details must be an object with an optional title and notes.',
  'The report title must be a string of at most 240 characters.',
  'Report notes must be a string of at most 5,000 characters.',
  'Comparison settings must be an object with latency thresholds.',
  'Latency thresholds must be finite, non-negative numbers within the supported range.',
]);
const SAFE_REQUEST_MESSAGE = /^Request [1-9]\d* (?:is missing its request or response object\. Export a fresh HAR file\.|is missing a URL\. Export a fresh HAR file\.|has a URL longer than 32 KB\. Export a smaller recording or remove this request\.)$/;

function safeError(error, name) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (SAFE_CORE_MESSAGES.has(message) || SAFE_REQUEST_MESSAGE.test(message)) return { name, message };
  return { name: 'TraceProcessingError', message: 'The recording could not be processed. Export a fresh HAR and try again.' };
}

function validateReportDetails(details = {}) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new Error('Report details must be an object with an optional title and notes.');
  }
  const { title, notes = '' } = details;
  if (title !== undefined && (typeof title !== 'string' || title.length > 240)) {
    throw new Error('The report title must be a string of at most 240 characters.');
  }
  if (typeof notes !== 'string' || notes.length > 5000) {
    throw new Error('Report notes must be a string of at most 5,000 characters.');
  }
  return { ...(title === undefined ? {} : { title }), notes };
}

function shareSnapshot(result, preserveRoutes, reportDetails = {}) {
  const safe = result.har;
  return {
    safe,
    audit: result.audit,
    harText: `${JSON.stringify(safe, null, 2)}\n`,
    reportText: buildReport(safe, reportDetails),
    auditText: `${JSON.stringify({ tool: 'TraceTidy', policy: 'strict-v1', preserveRoutes: preserveRoutes === true, includesAuthorNotes: Boolean(reportDetails.notes?.trim()), ...result.audit }, null, 2)}\n`,
  };
}

function comparisonOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Comparison settings must be an object with latency thresholds.');
  }
  const { latencyMs = 100, latencyPercent = 20 } = options;
  if (![latencyMs, latencyPercent].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    || latencyMs > 30 * 24 * 60 * 60 * 1000 || latencyPercent > Number.MAX_SAFE_INTEGER) {
    throw new Error('Latency thresholds must be finite, non-negative numbers within the supported range.');
  }
  return { latencyMs, latencyPercent };
}

/** Separate instances own separate caches; exported for worker protocol tests. */
export function createTraceWorkerHandler(postMessage) {
  let currentHar = null;
  let snapshot = null;
  let baselineHar = null;
  let comparisonSnapshot = null;
  const buildComparison = (options) => {
    const comparison = compareTraces(baselineHar, currentHar, options);
    return { comparison, comparisonText: buildComparisonMarkdown(comparison) };
  };
  return ({ data }) => {
    if (!data || !Number.isSafeInteger(data.requestId)) return;
    const { requestId, kind } = data;
    let errorName = 'TraceProcessingError';
    try {
      let payload;
      if (kind === 'load') {
        currentHar = null;
        snapshot = null;
        baselineHar = null;
        comparisonSnapshot = null;
        errorName = 'TraceValidationError';
        if (typeof data.source !== 'string') {
          postMessage({ requestId, ok: false, error: { name: 'TraceValidationError', message: 'Choose a HAR JSON file to load as text.' } });
          return;
        }
        currentHar = validateHar(data.source);
        errorName = 'TraceProcessingError';
        const summary = summarizeHar(currentHar);
        const insights = analyzeTrace(currentHar);
        errorName = 'RedactionError';
        const cleaned = sanitizeHar(currentHar);
        errorName = 'TraceProcessingError';
        snapshot = shareSnapshot(cleaned, false);
        payload = { har: currentHar, summary, insights, ...snapshot };
      } else if (kind === 'redact') {
        // A failed new policy must never leave an old share version available.
        snapshot = null;
        if (!currentHar) {
          postMessage({ requestId, ok: false, error: { name: 'NoTraceError', message: 'Import a HAR recording before changing its sharing rules.' } });
          return;
        }
        const options = data.options && typeof data.options === 'object' && !Array.isArray(data.options) ? data.options : { customTerms: null };
        errorName = 'RedactionError';
        const reportDetails = validateReportDetails(options.reportDetails);
        const cleaned = sanitizeHar(currentHar, options);
        errorName = 'TraceProcessingError';
        snapshot = shareSnapshot(cleaned, options.preserveRoutes, reportDetails);
        payload = snapshot;
      } else if (kind === 'setBaseline') {
        // Replacement starts by discarding both caches, including when its
        // source or comparison fails validation.
        baselineHar = null;
        comparisonSnapshot = null;
        if (!currentHar) {
          postMessage({ requestId, ok: false, error: { name: 'NoTraceError', message: 'Import a HAR recording before comparing a baseline.' } });
          return;
        }
        errorName = 'TraceValidationError';
        if (typeof data.source !== 'string') {
          postMessage({ requestId, ok: false, error: { name: 'TraceValidationError', message: 'Choose a HAR JSON file to load as a baseline.' } });
          return;
        }
        baselineHar = validateHar(data.source);
        errorName = 'TraceProcessingError';
        comparisonSnapshot = buildComparison({ latencyMs: 100, latencyPercent: 20 });
        payload = comparisonSnapshot;
      } else if (kind === 'compare') {
        comparisonSnapshot = null;
        if (!currentHar) {
          postMessage({ requestId, ok: false, error: { name: 'NoTraceError', message: 'Import a HAR recording before comparing a baseline.' } });
          return;
        }
        if (!baselineHar) {
          postMessage({ requestId, ok: false, error: { name: 'NoBaselineError', message: 'Import a baseline HAR recording before comparing traces.' } });
          return;
        }
        errorName = 'ComparisonValidationError';
        const options = comparisonOptions(data.options);
        errorName = 'TraceProcessingError';
        comparisonSnapshot = buildComparison(options);
        payload = comparisonSnapshot;
      } else if (kind === 'clearBaseline') {
        baselineHar = null;
        comparisonSnapshot = null;
        payload = { comparison: null, comparisonText: '' };
      } else if (kind === 'bundle') {
        if (!snapshot) {
          postMessage({ requestId, ok: false, error: { name: 'NoSnapshotError', message: 'Wait for a successful share preview before downloading a share pack.' } });
          return;
        }
        payload = createZip({
          'safe.har': snapshot.harText,
          'issue.md': snapshot.reportText,
          'audit.json': snapshot.auditText,
          ...(comparisonSnapshot ? { 'comparison.md': comparisonSnapshot.comparisonText } : {}),
        });
      } else {
        postMessage({ requestId, ok: false, error: { name: 'WorkerMessageError', message: 'The trace worker received an unsupported operation.' } });
        return;
      }
      postMessage({ requestId, ok: true, payload });
    } catch (error) {
      if (kind === 'load') currentHar = null;
      if (kind === 'load' || kind === 'redact') snapshot = null;
      if (kind === 'load' || kind === 'setBaseline') baselineHar = null;
      if (kind === 'load' || kind === 'setBaseline' || kind === 'compare') comparisonSnapshot = null;
      postMessage({ requestId, ok: false, error: safeError(error, errorName) });
    }
  };
}

// The guard keeps this module importable in Node protocol tests, with no global
// cache or trace retained outside the dedicated worker's lifetime.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = createTraceWorkerHandler((message) => self.postMessage(message));
}
