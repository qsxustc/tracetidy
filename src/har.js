/**
 * TraceTidy's dependency-free HAR reader, share sanitizer, and report builder.
 * Sanitization rebuilds a small standard HAR allowlist. It never mutates input.
 */

import { analyzeTrace, requestDuration } from './insights.js';
import { VERSION } from './version.js';

const MAX_SOURCE_LENGTH = 50 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const MAX_URL_LENGTH = 32_768;
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_TIME = 30 * 24 * 60 * 60 * 1000;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/problem+json',
  'application/javascript', 'application/x-javascript', 'application/xml',
  'application/xhtml+xml', 'application/octet-stream', 'application/pdf',
  'application/zip', 'application/gzip', 'application/wasm',
  'application/x-www-form-urlencoded', 'application/graphql',
  'application/vnd.api+json', 'application/vnd.apple.mpegurl',
  'multipart/form-data', 'multipart/mixed',
  'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/xml',
  'text/csv', 'text/event-stream', 'text/markdown',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon',
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf',
  'application/font-woff', 'application/vnd.ms-fontobject',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
  'video/mp4', 'video/webm', 'video/ogg',
]);
const CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'iso-8859-1', 'utf-16', 'windows-1252']);
const ENCODINGS = new Set(['gzip', 'deflate', 'br', 'zstd', 'identity', 'compress']);
const CACHE_FLAGS = new Set([
  'public', 'private', 'no-cache', 'no-store', 'no-transform',
  'must-revalidate', 'proxy-revalidate', 'immutable', 'only-if-cached',
]);
const CACHE_NUMBERS = new Set(['max-age', 's-maxage', 'min-fresh', 'max-stale', 'stale-while-revalidate', 'stale-if-error']);
const EPOCH = '1970-01-01T00:00:00.000Z';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isObject(value) && Object.hasOwn(value, key);

function number(value, fallback = 0, min = 0, max = MAX_NUMBER) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback;
}

function integer(value, fallback = 0, min = 0, max = MAX_NUMBER) {
  return Math.trunc(number(value, fallback, min, max));
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(value, fallback = EPOCH) {
  const parsed = timestamp(value);
  return parsed === null ? fallback : new Date(parsed).toISOString();
}

/** Validate a HAR file or JSON object and return an independent JSON copy. */
export function validateHar(source) {
  let serialized;
  if (typeof source === 'string') {
    serialized = source;
  } else if (isObject(source)) {
    try {
      serialized = JSON.stringify(source);
    } catch {
      throw new Error('HAR input must contain JSON data without circular references. Export a fresh HAR file from your browser.');
    }
  } else {
    throw new Error('Choose a HAR JSON file or pass a HAR object with log.entries.');
  }
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new Error('The HAR file is empty. Export a network recording from your browser first.');
  }
  if (serialized.length > MAX_SOURCE_LENGTH) {
    throw new Error('The HAR file exceeds the 50 MB text limit. Export a shorter network recording.');
  }
  let har;
  try {
    har = JSON.parse(serialized);
  } catch {
    throw new Error('The file is not valid JSON. Export a HAR file from the Network panel, then try again.');
  }
  if (!isObject(har) || !isObject(har.log) || !Array.isArray(har.log.entries)) {
    throw new Error('This JSON is missing log.entries. Export a HAR file from your browser’s Network panel.');
  }
  if (har.log.entries.length > MAX_ENTRIES) {
    throw new Error('This HAR contains more than 50,000 requests. Export a shorter recording.');
  }
  har.log.entries.forEach((entry, index) => {
    const position = index + 1;
    if (!isObject(entry) || !isObject(entry.request) || !isObject(entry.response)) {
      throw new Error(`Request ${position} is missing its request or response object. Export a fresh HAR file.`);
    }
    if (typeof entry.request.url !== 'string' || !entry.request.url.trim()) {
      throw new Error(`Request ${position} is missing a URL. Export a fresh HAR file.`);
    }
    if (entry.request.url.length > MAX_URL_LENGTH) {
      throw new Error(`Request ${position} has a URL longer than 32 KB. Export a smaller recording or remove this request.`);
    }
  });
  return har;
}

function customMasker(terms) {
  if (!Array.isArray(terms)) throw new Error('customTerms must be an array of words or phrases to redact.');
  if (terms.length > 100) throw new Error('Use at most 100 custom redaction terms.');
  const cleaned = [...new Map(terms.map((term) => {
    if (typeof term !== 'string') throw new Error('Each custom redaction term must be a string.');
    const text = term.trim();
    if (text.length > 256) throw new Error('Each custom redaction term must be at most 256 characters.');
    return [text.toLocaleLowerCase('en-US'), text];
  }).filter(([, term]) => term)).values()].sort((a, b) => b.length - a.length);
  const replacement = ['[redacted]', '[masked]', '[removed]', '***'].find((candidate) =>
    !cleaned.some((term) => candidate.toLocaleLowerCase('en-US').includes(term.toLocaleLowerCase('en-US')))) || '';
  const expression = cleaned.length
    ? new RegExp(cleaned.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi')
    : null;
  return {
    replacement,
    matches(value) {
      if (!expression) return false;
      expression.lastIndex = 0;
      return expression.test(value);
    },
    apply(value, audit) {
      if (!expression) return value;
      expression.lastIndex = 0;
      return value.replace(expression, () => {
        if (audit) audit.maskedValues += 1;
        return replacement;
      });
    },
  };
}

function decodeSegment(value) {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function scrubIdentity(value, mask, audit) {
  let cleaned = decodeSegment(value);
  const redact = () => {
    audit.maskedValues += 1;
    return mask.replacement;
  };
  cleaned = cleaned.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, redact);
  cleaned = cleaned.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, redact);
  if (/^\d+$/.test(cleaned)) cleaned = redact();
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cleaned) && cleaned.length >= 30) cleaned = redact();
  cleaned = cleaned.replace(/[a-f0-9]{16,}|[A-Za-z0-9_-]{24,}/gi, redact);
  cleaned = cleaned.replace(/[\u0000-\u001f\u007f]/g, '');
  return mask.apply(cleaned, audit);
}

function parsedUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function urlSanitizer({ preserveRoutes, mask, audit }) {
  const hosts = new Map();
  const routes = new Map();
  const parameters = new Map();
  const alias = (map, key, prefix) => {
    if (!map.has(key)) map.set(key, `${prefix}-${map.size + 1}`);
    return map.get(key);
  };
  return (raw) => {
    const parsed = parsedUrl(raw);
    const origin = parsed?.origin ?? 'invalid-origin';
    const pathname = parsed?.pathname ?? '/';
    const params = parsed ? [...parsed.searchParams] : [];
    let host;
    let path;
    if (preserveRoutes && parsed) {
      host = parsed.hostname;
      if (mask.matches(host) || host.length > 253 || host.split('.').some((label) => label.length > 63)) {
        host = `${alias(hosts, origin, 'host')}.invalid`;
        audit.generalizedHosts += 1;
        audit.maskedValues += 1;
      }
      // URL accepts arbitrary numeric ports; only actual TCP port numbers survive.
      if (parsed.port && Number(parsed.port) > 0 && Number(parsed.port) <= 65535) host += `:${parsed.port}`;
      path = pathname.split('/').map((segment) => encodeURIComponent(scrubIdentity(segment, mask, audit))).join('/') || '/';
    } else {
      host = `${alias(hosts, origin, 'host')}.invalid`;
      path = `/${alias(routes, `${origin}${pathname}`, 'route')}`;
      audit.generalizedHosts += 1;
      audit.generalizedPaths += 1;
    }
    const queryString = params.map(([name], index) => {
      let safeName = alias(parameters, name, 'param');
      if (preserveRoutes && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) {
        safeName = scrubIdentity(name, mask, audit);
        if (!safeName) safeName = `param-${index + 1}`;
      }
      audit.maskedQueryValues += 1;
      audit.maskedValues += 1;
      return { name: safeName, value: mask.replacement };
    });
    const query = queryString.length ? `?${new URLSearchParams(queryString.map(({ name, value }) => [name, value]))}` : '';
    const protocol = parsed?.protocol ?? 'https:';
    return { url: `${protocol}//${host}${path}${query}`, queryString };
  };
}

function mimeType(value) {
  if (typeof value !== 'string' || value.length > 200 || /[\r\n\u0000]/.test(value)) return 'application/octet-stream';
  const base = value.split(';', 1)[0].trim().toLowerCase();
  return MIME_TYPES.has(base) ? base : 'application/octet-stream';
}

function weightedList(value, itemParser) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\u0000]/.test(value)) return null;
  const output = [];
  for (const item of value.split(',')) {
    const match = item.trim().toLowerCase().match(/^([^;]+?)(?:\s*;\s*q=(0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?$/);
    if (!match) return null;
    const safe = itemParser(match[1].trim());
    if (!safe) return null;
    output.push(`${safe}${match[2] === undefined ? '' : `;q=${Number(match[2])}`}`);
  }
  return output.length ? output.join(', ') : null;
}

function headerValue(name, value) {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n\u0000]/.test(value)) return null;
  switch (name) {
    case 'content-type': {
      const [base, ...parameters] = value.toLowerCase().split(';').map((part) => part.trim());
      if (!MIME_TYPES.has(base)) return null;
      let charset = '';
      for (const parameter of parameters) {
        const match = parameter.match(/^charset="?([a-z0-9-]+)"?$/);
        if (match && CHARSETS.has(match[1])) charset = `; charset=${match[1]}`;
      }
      return `${base}${charset}`;
    }
    case 'accept':
      return weightedList(value, (item) => MIME_TYPES.has(item) || item === '*/*' || ['text/*', 'image/*', 'audio/*', 'video/*', 'application/*'].includes(item) ? item : null);
    case 'accept-encoding':
      return weightedList(value, (item) => ENCODINGS.has(item) || item === '*' ? item : null);
    case 'content-encoding':
      return weightedList(value, (item) => ENCODINGS.has(item) ? item : null);
    case 'content-length':
      return /^\d{1,15}$/.test(value.trim()) && Number(value) <= MAX_NUMBER ? String(Number(value)) : null;
    case 'pragma':
      return value.trim().toLowerCase() === 'no-cache' ? 'no-cache' : null;
    case 'cache-control': {
      const parts = value.toLowerCase().split(',').map((part) => part.trim());
      const safe = parts.filter((part) => {
        if (CACHE_FLAGS.has(part)) return true;
        const match = part.match(/^([a-z-]+)=(\d{1,10})$/);
        return match && CACHE_NUMBERS.has(match[1]);
      });
      return safe.length ? safe.join(', ') : null;
    }
    default:
      return null;
  }
}

function countExtraFields(value, allowed, audit) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) audit.strippedFields += 1;
}

function headers(source, mask, audit) {
  if (!Array.isArray(source)) return [];
  const output = [];
  source.forEach((header, index) => {
    countExtraFields(header, ['name', 'value'], audit);
    const name = typeof header?.name === 'string' ? header.name.toLowerCase() : '';
    const value = index < 1000 ? headerValue(name, header?.value) : null;
    if (value === null || mask.matches(name) || mask.matches(value)) {
      audit.removedHeaders += 1;
    } else {
      output.push({ name, value });
    }
  });
  return output;
}

function httpVersion(value) {
  switch (value) {
    case 'HTTP/1.0': return 'HTTP/1.0';
    case 'HTTP/1.1': return 'HTTP/1.1';
    case 'HTTP/2': case 'HTTP/2.0': case 'h2': return 'HTTP/2.0';
    case 'HTTP/3': case 'HTTP/3.0': case 'h3': return 'HTTP/3.0';
    default: return 'HTTP/1.1';
  }
}

function timings(source, audit) {
  const result = {};
  countExtraFields(source, ['blocked', 'dns', 'connect', 'send', 'wait', 'receive', 'ssl'], audit);
  for (const field of ['blocked', 'dns', 'connect', 'send', 'wait', 'receive', 'ssl']) {
    result[field] = number(source?.[field], field === 'ssl' ? -1 : 0, ['send', 'wait', 'receive'].includes(field) ? 0 : -1, MAX_TIME);
  }
  return result;
}

function applyCustomToStrings(value, mask, audit) {
  if (typeof value === 'string') return mask.apply(value, audit);
  if (Array.isArray(value)) return value.map((item) => applyCustomToStrings(item, mask, audit));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyCustomToStrings(item, mask, audit)]));
  return value;
}

function verifyShareStructure(har, mask) {
  const conflict = () => {
    throw new Error('A custom term conflicts with a structural HAR value. Use a more specific private term.');
  };
  const versions = new Set(['HTTP/1.0', 'HTTP/1.1', 'HTTP/2.0', 'HTTP/3.0']);
  if (har.log.version !== '1.2' || har.log.creator.version !== VERSION) conflict();
  for (const entry of har.log.entries) {
    if (timestamp(entry.startedDateTime) === null) conflict();
    if (!METHODS.has(entry.request.method) && entry.request.method !== 'OTHER') conflict();
    if (!versions.has(entry.request.httpVersion) || !versions.has(entry.response.httpVersion)) conflict();
    for (const message of [entry.request, entry.response]) {
      const key = message === entry.request ? 'url' : 'redirectURL';
      if (key === 'redirectURL' && !message[key]) continue;
      const parsed = parsedUrl(message[key]);
      if (!parsed || parsed.username || parsed.password || parsed.hash || /%(?![0-9a-f]{2})/i.test(message[key])) conflict();
      // A custom replacement in a route or parameter must still produce a
      // properly encoded URL. The array follows this final URL, never input.
      parsed.pathname = parsed.pathname.split('/').map((segment) => encodeURIComponent(decodeSegment(segment))).join('/');
      const queryString = [...parsed.searchParams].map(([name, value]) => ({ name, value }));
      parsed.search = queryString.length ? `?${new URLSearchParams(queryString.map(({ name, value }) => [name, value]))}` : '';
      const canonical = parsed.href;
      if (mask.matches(canonical) || queryString.some(({ name, value }) => mask.matches(name) || mask.matches(value))) conflict();
      message[key] = canonical;
      if (key === 'url') message.queryString = queryString;
    }
  }
}

/**
 * Rebuild a shareable HAR. Routes and hosts are aliases unless preserveRoutes is
 * explicitly true. Preserved routes use best-effort identity scrubbing; review
 * them before sharing because ordinary names are not reliably recognizable.
 */
export function sanitizeHar(source, { customTerms = [], preserveRoutes = false } = {}) {
  const har = validateHar(source);
  const audit = {
    removedBodies: 0, removedCookies: 0, removedHeaders: 0,
    maskedQueryValues: 0, maskedValues: 0, strippedFields: 0,
    generalizedHosts: 0, generalizedPaths: 0,
  };
  const mask = customMasker(customTerms);
  const sanitizeUrl = urlSanitizer({ preserveRoutes: preserveRoutes === true, mask, audit });
  const validStarts = har.log.entries.map((entry) => timestamp(entry.startedDateTime)).filter((value) => value !== null);
  const earliest = validStarts.length ? new Date(Math.min(...validStarts)).toISOString() : EPOCH;
  countExtraFields(har, ['log'], audit);
  countExtraFields(har.log, ['version', 'creator', 'entries'], audit);
  countExtraFields(har.log.creator, ['name', 'version'], audit);
  const entries = har.log.entries.map((entry) => {
    countExtraFields(entry, ['startedDateTime', 'time', 'request', 'response', 'cache', 'timings'], audit);
    const request = entry.request;
    const response = entry.response;
    countExtraFields(request, ['method', 'url', 'httpVersion', 'cookies', 'headers', 'queryString', 'headersSize', 'bodySize'], audit);
    countExtraFields(response, ['status', 'statusText', 'httpVersion', 'cookies', 'headers', 'content', 'redirectURL', 'headersSize', 'bodySize'], audit);
    countExtraFields(response.content, ['size', 'compression', 'mimeType'], audit);
    // Cache entries can contain arbitrary headers and comments. Keep an empty
    // standard cache object rather than attempting to copy them.
    audit.strippedFields += isObject(entry.cache) ? Object.keys(entry.cache).length : 0;
    for (const cookies of [request.cookies, response.cookies]) {
      if (Array.isArray(cookies)) audit.removedCookies += cookies.length;
    }
    if (own(request, 'postData')) audit.removedBodies += 1;
    if (own(response.content, 'text')) audit.removedBodies += 1;
    if (Array.isArray(request.queryString)) {
      request.queryString.forEach((query) => countExtraFields(query, ['name', 'value'], audit));
    }
    const cleanedUrl = sanitizeUrl(request.url);
    if (Array.isArray(request.queryString) && request.queryString.length > cleanedUrl.queryString.length) {
      audit.maskedQueryValues += request.queryString.length - cleanedUrl.queryString.length;
    }
    const cleanedTimings = timings(entry.timings, audit);
    const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'OTHER';
    const content = {
      size: integer(response.content?.size, 0),
      mimeType: mimeType(response.content?.mimeType),
    };
    if (typeof response.content?.compression === 'number' && Number.isFinite(response.content.compression)) {
      content.compression = integer(response.content.compression);
    }
    return {
      startedDateTime: date(entry.startedDateTime, earliest),
      time: requestDuration(entry),
      request: {
        method: METHODS.has(method) ? method : 'OTHER',
        url: cleanedUrl.url,
        httpVersion: httpVersion(request.httpVersion),
        cookies: [],
        headers: headers(request.headers, mask, audit),
        queryString: cleanedUrl.queryString,
        headersSize: integer(request.headersSize, -1, -1),
        bodySize: integer(request.bodySize, -1, -1),
      },
      response: {
        status: integer(response.status, 0, 0, 599),
        statusText: '',
        httpVersion: httpVersion(response.httpVersion),
        cookies: [],
        headers: headers(response.headers, mask, audit),
        content,
        redirectURL: typeof response.redirectURL === 'string' && response.redirectURL ? sanitizeUrl(response.redirectURL).url : '',
        headersSize: integer(response.headersSize, -1, -1),
        bodySize: integer(response.bodySize, -1, -1),
      },
      cache: {},
      timings: cleanedTimings,
    };
  });
  const rebuilt = {
    log: { version: '1.2', creator: { name: 'TraceTidy', version: VERSION }, entries },
  };
  const result = applyCustomToStrings(rebuilt, mask, audit);
  // Custom terms may themselves match a fixed MIME label. An empty MIME type
  // keeps the HAR valid without introducing a fresh term via a fallback label.
  for (const entry of result.log.entries) {
    if (!MIME_TYPES.has(entry.response.content.mimeType)) entry.response.content.mimeType = '';
  }
  verifyShareStructure(result, mask);
  return { har: result, audit };
}

/** Summarize either a local original HAR or an already sanitized HAR. */
export function summarizeHar(har) {
  const source = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const starts = source.map((entry) => timestamp(entry?.startedDateTime));
  const validStarts = starts.filter((value) => value !== null);
  const firstStart = validStarts.length ? Math.min(...validStarts) : 0;
  const hosts = new Set();
  let totalBytes = 0;
  let durationMs = 0;
  let slowestMs = 0;
  let failureCount = 0;
  const entries = source.map((entry, index) => {
    const url = typeof entry?.request?.url === 'string' ? entry.request.url : '';
    const parsed = parsedUrl(url);
    const host = parsed?.host ?? '';
    if (host) hosts.add(host);
    const time = requestDuration(entry);
    const startOffset = starts[index] === null ? 0 : Math.max(0, starts[index] - firstStart);
    const status = integer(entry?.response?.status, 0, 0, 599);
    const failed = status === 0 || status >= 400;
    if (failed) failureCount += 1;
    const declaredSize = number(entry?.response?.bodySize, -1, -1);
    const bodySize = declaredSize >= 0 ? declaredSize : integer(entry?.response?.content?.size, 0);
    totalBytes = Math.min(MAX_NUMBER, totalBytes + bodySize);
    durationMs = Math.min(MAX_NUMBER, Math.max(durationMs, startOffset + time));
    slowestMs = Math.max(slowestMs, time);
    return {
      index, url,
      method: typeof entry?.request?.method === 'string' && METHODS.has(entry.request.method.toUpperCase()) ? entry.request.method.toUpperCase() : 'OTHER',
      status, time, startOffset, bodySize,
      mimeType: mimeType(entry?.response?.content?.mimeType),
      host, path: parsed?.pathname ?? '/', failed,
    };
  });
  return { requestCount: entries.length, failureCount, totalBytes, durationMs, slowestMs, hostCount: hosts.size, entries };
}

function markdownText(value, limit = 20_000) {
  return String(value ?? '').slice(0, limit)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
}

function cell(value) {
  return markdownText(value, MAX_URL_LENGTH).replace(/[\r\n]+/g, ' ');
}

function bytes(value) {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function requestTable(entries) {
  return [
    '| # | Method | Status | Time | Response size | URL |',
    '| --- | --- | --- | --- | --- | --- |',
    ...entries.map((entry) => `| ${entry.index + 1} | ${cell(entry.method)} | ${entry.status || 'Network error'} | ${Math.round(entry.time)} ms | ${bytes(entry.bodySize)} | ${cell(entry.url)} |`),
  ];
}

/** Build a Markdown investigation report from the caller's sanitized HAR. */
export function buildReport(har, { title = 'Network investigation', notes = '' } = {}) {
  const summary = summarizeHar(har);
  const insights = analyzeTrace(har);
  const slowest = [...summary.entries].sort((a, b) => b.time - a.time || a.index - b.index).slice(0, 10);
  const failures = summary.entries.filter((entry) => entry.failed);
  const lines = [
    `# ${markdownText(title || 'Network investigation', 240).replace(/[\r\n]+/g, ' ')}`,
    '',
    'Generated by TraceTidy from the HAR supplied to the report builder.',
    '',
    '## Recording summary',
    '',
    `- Requests: ${summary.requestCount}`,
    `- Failed requests: ${summary.failureCount} (HTTP 4xx/5xx or status 0)`,
    `- Hosts: ${summary.hostCount}`,
    `- Recorded duration: ${Math.round(summary.durationMs)} ms`,
    `- Slowest request: ${Math.round(summary.slowestMs)} ms`,
    `- P95 request duration: ${Math.round(insights.stats.p95Ms)} ms (nearest rank over normalized durations; missing total time uses recorded phases, or 0 if no timing is available)`,
    `- Slow requests (at least 1 second): ${insights.stats.slowRequests}`,
    `- Recorded response bytes: ${bytes(summary.totalBytes)}`,
    '',
    'Response bytes use HAR bodySize when available, otherwise content.size. Browser caching and compression can affect these values.',
  ];
  if (String(notes).trim()) lines.push('', '## Investigation notes', '',
    'The following author-supplied context is included as entered. Custom HAR redaction rules do not process these notes.',
    '', markdownText(notes));
  lines.push('', '## Triage observations', '',
    'These are observations from recorded values, not a diagnosis of the underlying cause. Missing status values are normalized to 0. Timing phases can be incomplete or inconsistent in a HAR. Unknown durations become 0 and can understate P95 and average latency.');
  for (const finding of insights.findings) {
    const references = finding.indices.slice(0, 10).map((index) => `#${index + 1}`).join(', ');
    const suffix = finding.count > 10 ? `; showing 10 of ${finding.count}` : '';
    const slowest = Math.round(finding.metrics.slowestMs);
    const descriptions = {
      'network-errors': `${finding.count} request(s) have status 0; the recording does not establish why no HTTP status was available.`,
      'status-5xx': `${finding.count} request(s) returned HTTP 5xx. Inspect the corresponding service logs and reproduction context.`,
      'status-4xx': `${finding.count} request(s) returned HTTP 4xx. Check the request context and whether that status was expected.`,
      'slow-ttfb': `${finding.count} request(s) took at least 1 second with waiting accounting for at least 70% of recorded time. Compare waiting timings with service and connection evidence.`,
      'slow-download': `${finding.count} request(s) took at least 1 second with receive accounting for at least 50% of recorded time. Compare response size and transfer conditions.`,
      'repeated-requests': `${finding.count} request(s) share ${finding.metrics.endpointCount} method-and-endpoint group(s) called at least 3 times, ignoring query values. Repetition can be expected; this does not establish retries.`,
    };
    lines.push('', `- ${descriptions[finding.id]} Slowest: ${slowest} ms. Requests: ${references}${suffix}.`);
  }
  if (!insights.findings.length) lines.push('', 'No observations met the HTTP failure, timing-share, or repeated-request thresholds.');
  lines.push('', '## Endpoint summary', '',
    'Grouped by method, origin, and path; queries and fragments are excluded. Showing up to 10 groups by summed request time. Summed time includes overlapping requests and is not wall-clock duration.', '');
  if (insights.endpoints.length) {
    lines.push('| Method | Endpoint | Requests | Failed | P95 | Average | Summed time | Response size | Status counts |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...insights.endpoints.slice(0, 10).map((endpoint) => {
        const statuses = Object.entries(endpoint.statuses).map(([status, count]) => `${status}: ${count}`).join(', ');
        return `| ${cell(endpoint.method)} | ${cell(endpoint.url || '(URL unavailable)')} | ${endpoint.count} | ${endpoint.failures} | ${Math.round(endpoint.p95Ms)} ms | ${Math.round(endpoint.avgMs)} ms | ${Math.round(endpoint.totalTimeMs)} ms | ${bytes(endpoint.totalBytes)} | ${cell(statuses)} |`;
      }));
  } else lines.push('No endpoints were recorded.');
  lines.push('', '## Slowest requests', '');
  if (slowest.length) lines.push(...requestTable(slowest));
  else lines.push('No requests were recorded.');
  lines.push('', '## Failed requests', '');
  if (failures.length) {
    lines.push(...requestTable(failures.slice(0, 20)));
    if (failures.length > 20) lines.push('', `Showing the first 20 of ${failures.length} failed requests.`);
  } else lines.push('No HTTP or network failures were recorded.');
  lines.push('', '## Sharing review', '',
    'TraceTidy removes bodies, cookies, and non-allowlisted headers when sanitizing. Default exports replace hosts, routes, and query names with stable aliases. Preserved routes use best-effort scrubbing and may still contain names or other sensitive context. Review this report and the exported HAR before sharing.', '');
  return lines.join('\n');
}
