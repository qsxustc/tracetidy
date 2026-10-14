#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { validateHar, summarizeHar, sanitizeHar, buildReport } from '../src/har.js';
import { analyzeTrace } from '../src/insights.js';

const DEFAULT_REQUESTS = 10_000;
const MAX_REQUESTS = 50_000;
const BODY_BYTES = 1800;
const HELP = `TraceTidy synthetic core benchmark

Usage:
  node scripts/benchmark.js [--requests <1..50000>]

The default is 10000 requests, with 1800 ASCII response-body bytes each.
The generated HAR stays in memory; no files or network requests are used.
Large workloads can exceed the HAR core's 50 MiB text limit and are rejected.
These timings measure one local Node.js pass, not browser or Worker latency.
`;

class BenchmarkError extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

function parseArgs(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
  if (!args.length) return { requests: DEFAULT_REQUESTS };
  if (args.length !== 2 || args[0] !== '--requests' || !/^\d{1,5}$/.test(args[1])) {
    throw new BenchmarkError('Use --requests followed by an integer from 1 to 50000. Use --help for usage.');
  }
  const requests = Number(args[1]);
  if (!Number.isSafeInteger(requests) || requests < 1 || requests > MAX_REQUESTS) {
    throw new BenchmarkError('The request count must be an integer from 1 to 50000.');
  }
  return { requests };
}

function syntheticHar(requests) {
  const body = 'SYNTHETIC '.repeat(BODY_BYTES / 10);
  const epoch = Date.parse('2026-01-01T00:00:00.000Z');
  const entries = Array.from({ length: requests }, (_, index) => {
    const time = 100 + (index % 31) * 50;
    const receive = index % 29 === 0 ? Math.floor(time * 0.7) : 18;
    return {
      startedDateTime: new Date(epoch + index * 5).toISOString(),
      time,
      request: {
        method: index % 7 === 0 ? 'POST' : 'GET',
        url: `https://benchmark.invalid/api/items/${index % 100}?token=synthetic-only`,
        httpVersion: 'HTTP/2.0', cookies: [], queryString: [],
        headers: [{ name: 'Authorization', value: 'Bearer SYNTHETIC_BENCHMARK_TOKEN' }],
        headersSize: 80, bodySize: 0,
      },
      response: {
        status: index % 50 === 0 ? 500 : index % 37 === 0 ? 401 : 200,
        statusText: '', httpVersion: 'HTTP/2.0', cookies: [], headers: [],
        content: { size: BODY_BYTES, mimeType: 'text/plain', text: body },
        redirectURL: '', headersSize: 50, bodySize: BODY_BYTES,
      },
      cache: {},
      timings: { blocked: 2, dns: 3, connect: 8, ssl: 4, send: 1, wait: time - 14 - receive, receive },
    };
  });
  return { log: { version: '1.2', creator: { name: 'TraceTidy synthetic benchmark', version: '1' }, entries } };
}

function size(bytes) { return `${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`; }

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }

  // Fixture creation and its first serialization are deliberately not timed.
  const raw = JSON.stringify(syntheticHar(options.requests));
  const inputBytes = Buffer.byteLength(raw, 'utf8');
  const timings = [];
  function measure(name, operation) {
    const start = performance.now();
    const value = operation();
    timings.push({ name, ms: performance.now() - start });
    return value;
  }

  let har;
  try { har = measure('Validate + parse', () => validateHar(raw)); }
  catch {
    throw new BenchmarkError(`Generated synthetic input (${size(inputBytes)}) was rejected by the HAR core. The core text limit is 50 MiB; try a smaller --requests value.`, 1);
  }
  const summary = measure('Summarize original', () => summarizeHar(har));
  const safe = measure('Sanitize (default aliases)', () => sanitizeHar(har));
  const insights = measure('Analyze sanitized trace', () => analyzeTrace(safe.har));
  const report = measure('Build sanitized report', () => buildReport(safe.har));
  const serialized = measure('Serialize export JSON', () => ({
    har: `${JSON.stringify(safe.har, null, 2)}\n`,
    audit: `${JSON.stringify(safe.audit, null, 2)}\n`,
  }));

  process.stdout.write([
    'TraceTidy synthetic core benchmark',
    `Runtime: ${process.version} (${process.platform}/${process.arch})`,
    `Requests: ${options.requests}; response body: ${BODY_BYTES} ASCII bytes per request`,
    `Input HAR: ${size(inputBytes)}`,
    `Sanitized HAR: ${size(Buffer.byteLength(serialized.har, 'utf8'))}`,
    `Report: ${size(Buffer.byteLength(report, 'utf8'))}`,
    `Audit: ${size(Buffer.byteLength(serialized.audit, 'utf8'))}`,
    `HTTP failures: ${summary.failureCount}; endpoint groups: ${insights.endpoints.length}`,
    '',
    'Stage | Time (ms)',
    '--- | ---:',
    ...timings.map(({ name, ms }) => `${name} | ${ms.toFixed(2)}`),
    `Total measured stages | ${timings.reduce((sum, stage) => sum + stage.ms, 0).toFixed(2)}`,
    '',
    'One local Node.js pass; no warm-up or repeated-run average.',
    'Fixture generation, file I/O, ZIP creation, browser rendering, Worker messaging,',
    'and browser responsiveness are excluded. Report generation includes its own',
    'summary and analysis; standalone stage timings are not a cached UI pipeline.',
    'Only synthetic data was generated in memory. No HAR files were written.',
    '',
  ].join('\n'));
}

try { main(); }
catch (error) {
  const known = error instanceof BenchmarkError;
  process.stderr.write(`TraceTidy benchmark: ${known ? error.message : 'The synthetic workload could not be processed. Try a smaller --requests value.'}\n`);
  process.exitCode = known ? error.code : 1;
}
