import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHar, sanitizeHar, summarizeHar, buildReport } from '../src/har.js';

function entry(overrides = {}) {
  return {
    startedDateTime: '2026-01-02T03:04:05.000Z',
    time: 150,
    request: {
      method: 'GET', url: 'https://api.example.com/v1/tasks?sort=new&token=private',
      httpVersion: 'HTTP/2.0', cookies: [], headers: [], queryString: [],
      headersSize: 30, bodySize: 0,
    },
    response: {
      status: 200, statusText: 'OK', httpVersion: 'HTTP/2.0',
      cookies: [], headers: [],
      content: { size: 1024, mimeType: 'application/json', text: '{"private":true}' },
      redirectURL: '', headersSize: 50, bodySize: 512,
    },
    cache: {}, timings: { blocked: -1, dns: 0, connect: 10, ssl: 5, send: 1, wait: 130, receive: 9 },
    ...overrides,
  };
}

function har(entries = [entry()]) {
  return { log: { version: '1.2', creator: { name: 'Browser', version: '100' }, entries } };
}

test('validates JSON and objects into independent copies', () => {
  const original = har();
  const fromObject = validateHar(original);
  const fromText = validateHar(JSON.stringify(original));
  assert.deepEqual(fromText, original);
  assert.deepEqual(fromObject, original);
  assert.notEqual(fromObject, original);
  assert.notEqual(fromObject.log.entries[0], original.log.entries[0]);
  fromObject.log.entries[0].request.url = 'https://changed.invalid/';
  assert.notEqual(fromObject.log.entries[0].request.url, original.log.entries[0].request.url);
});

test('actionable validation errors do not echo untrusted contents', () => {
  for (const input of [null, [], 10, '', 'private-sensitive-sentinel', '{}', { log: {} }, { log: { entries: [null] } }, har([{ request: {}, response: {} }])]) {
    assert.throws(() => validateHar(input), (error) => {
      assert.match(error.message, /HAR|JSON|Request|network/i);
      assert.ok(!error.message.includes('private-sensitive-sentinel'));
      return true;
    });
  }
  const circular = har();
  circular.log.self = circular;
  assert.throws(() => validateHar(circular), /circular/);
  assert.throws(() => validateHar(har([entry({ request: { url: 'x'.repeat(32_769) } })])), /32 KB/);
  assert.throws(() => validateHar({ log: { entries: Array.from({ length: 50_001 }, () => ({})) } }), /50,000/);
});

test('empty recordings are valid and summarize without non-finite numbers', () => {
  assert.deepEqual(summarizeHar(har([])), {
    requestCount: 0, failureCount: 0, totalBytes: 0, durationMs: 0,
    slowestMs: 0, hostCount: 0, entries: [],
  });
  const result = sanitizeHar(har([]));
  assert.deepEqual(result.har.log.entries, []);
  assert.match(buildReport(result.har), /No requests were recorded/);
});

test('default export generalizes topology with stable aliases and removes URL identity', () => {
  const first = entry();
  first.request.url = 'https://private-user:private-password@api.example.com:8443/users/Alice?token=private-token&token=second&sort=new#private-fragment';
  const second = entry();
  second.request.url = 'https://api.example.com:8443/users/Alice?sort=old';
  const third = entry();
  third.request.url = 'http://other.example.net/users/Alice?token=third';
  const result = sanitizeHar(har([first, second, third]));
  const urls = result.har.log.entries.map((item) => new URL(item.request.url));
  assert.equal(urls[0].host, 'host-1.invalid');
  assert.equal(urls[1].host, 'host-1.invalid');
  assert.equal(urls[2].host, 'host-2.invalid');
  assert.equal(urls[0].pathname, '/route-1');
  assert.equal(urls[1].pathname, '/route-1');
  assert.equal(urls[2].pathname, '/route-2');
  assert.equal(urls[2].protocol, 'http:');
  assert.deepEqual([...urls[0].searchParams], [['param-1', '[redacted]'], ['param-1', '[redacted]'], ['param-2', '[redacted]']]);
  for (const url of urls) {
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.port, '');
    assert.equal(url.hash, '');
  }
  const serialized = JSON.stringify(result);
  for (const secret of ['private-user', 'private-password', 'api.example.com', 'other.example.net', 'Alice', 'private-token', 'private-fragment']) {
    assert.ok(!serialized.includes(secret), `Default export leaked ${secret}`);
  }
  assert.equal(result.audit.generalizedHosts, 3);
  assert.equal(result.audit.generalizedPaths, 3);
  assert.equal(result.audit.maskedQueryValues, 5);
  assert.ok(!('mapping' in result));
});

test('URL is the source of truth for duplicate and inconsistent HAR query arrays', () => {
  const source = entry();
  source.request.queryString = [
    { name: 'private-cookie', value: 'extra-sensitive-value' },
    { name: 'private-cookie', value: 'second-sensitive-value', comment: 'hidden-query-comment' },
    { name: 'unrecorded', value: 'another-sensitive-value' },
  ];
  const { har: cleaned, audit } = sanitizeHar(har([source]));
  const output = cleaned.log.entries[0].request;
  assert.deepEqual(output.queryString, [...new URL(output.url).searchParams].map(([name, value]) => ({ name, value })));
  assert.equal(output.queryString.length, 2);
  assert.equal(audit.maskedQueryValues, 3);
  assert.ok(!JSON.stringify(cleaned).includes('sensitive'));
  source.request.url = 'https://api.example.com/plain';
  assert.deepEqual(sanitizeHar(har([source])).har.log.entries[0].request.queryString, []);
});

test('rebuilds standard HAR and drops hidden secrets at every structural level', () => {
  const secret = (name) => `SENTINEL_${name}_do_not_export`;
  const source = entry();
  source.comment = secret('entry_comment');
  source.pageref = secret('pageref');
  source.serverIPAddress = secret('ip');
  source.connection = secret('connection');
  source._initiator = { stack: secret('stack') };
  source._webSocketMessages = [{ data: secret('websocket') }];
  source._responseBody = secret('extra_body');
  source.request.url = `https://${secret('username')}:${secret('password')}@private.example.com/private-route?${secret('query_name')}=${secret('query_value')}#${secret('fragment')}`;
  source.request.method = secret('method');
  source.request.httpVersion = secret('request_http');
  source.request.comment = secret('request_comment');
  source.request._secret = secret('request_extension');
  source.request.postData = { mimeType: 'application/json', text: secret('post_body'), params: [{ name: secret('post_param'), value: secret('post_value') }] };
  source.request.cookies = [{ name: secret('request_cookie_name'), value: secret('request_cookie_value'), comment: secret('cookie_comment') }];
  source.request.queryString = [{ name: secret('query_array_name'), value: secret('query_array_value'), comment: secret('query_comment') }];
  source.request.headers = [
    { name: 'Authorization', value: secret('authorization') },
    { name: 'Cookie', value: secret('cookie_header') },
    { name: 'Referer', value: secret('referer') },
    { name: 'User-Agent', value: secret('agent') },
    { name: 'X-Api-Key', value: secret('key') },
    { name: 'Content-Type', value: `application/json; boundary=${secret('boundary')}`, comment: secret('header_comment') },
    { name: 'Accept', value: `application/${secret('accept_subtype')}` },
  ];
  source.response.statusText = secret('status_text');
  source.response.httpVersion = secret('response_http');
  source.response.comment = secret('response_comment');
  source.response._secret = secret('response_extension');
  source.response.content = {
    size: 256, mimeType: `application/${secret('mime')}`, text: secret('response_body'),
    encoding: secret('encoding'), comment: secret('content_comment'), _raw: secret('content_extension'),
  };
  source.response.cookies = [{ name: secret('response_cookie_name'), value: secret('response_cookie_value') }];
  source.response.headers = [
    { name: 'Set-Cookie', value: secret('set_cookie') },
    { name: 'Location', value: `https://private.example.com/${secret('location')}` },
    { name: 'Content-Disposition', value: secret('filename') },
    { name: 'Content-Type', value: `application/${secret('type_subtype')}` },
    { name: 'Cache-Control', value: `no-store, private="${secret('cache_header')}"` },
  ];
  source.response.redirectURL = `https://${secret('redirect_user')}@redirect.private.example.com/${secret('redirect_path')}?key=${secret('redirect_query')}#${secret('redirect_fragment')}`;
  source.cache = { beforeRequest: { eTag: secret('etag'), comment: secret('cache_comment') }, _raw: secret('cache_extension') };
  source.timings.comment = secret('timing_comment');
  source.timings._raw = secret('timing_extension');
  const original = har([source]);
  original.comment = secret('root');
  original._raw = secret('root_extension');
  original.log.comment = secret('log_comment');
  original.log.browser = { name: secret('browser') };
  original.log.creator.comment = secret('creator_comment');
  original.log.pages = [{ id: secret('page_id'), title: secret('page_title'), _url: secret('page_url'), pageTimings: { comment: secret('page_timing') } }];
  original.log._metadata = secret('log_extension');
  const before = JSON.stringify(original);
  const { har: cleaned, audit } = sanitizeHar(original);
  assert.equal(JSON.stringify(original), before, 'Sanitization mutated the source');
  assert.ok(!JSON.stringify(cleaned).includes('SENTINEL_'));
  assert.deepEqual(Object.keys(cleaned), ['log']);
  assert.deepEqual(Object.keys(cleaned.log), ['version', 'creator', 'entries']);
  assert.deepEqual(cleaned.log.creator, { name: 'TraceTidy', version: '0.1.0' });
  const output = cleaned.log.entries[0];
  assert.equal(output.request.method, 'OTHER');
  assert.equal(output.request.httpVersion, 'HTTP/1.1');
  assert.equal(output.response.statusText, '');
  assert.equal(output.response.content.mimeType, 'application/octet-stream');
  assert.deepEqual(output.request.cookies, []);
  assert.deepEqual(output.response.cookies, []);
  assert.deepEqual(output.cache, {});
  assert.ok(!('postData' in output.request));
  assert.ok(!('text' in output.response.content));
  assert.ok(!('encoding' in output.response.content));
  assert.equal(audit.removedBodies, 2);
  assert.equal(audit.removedCookies, 2);
  assert.equal(audit.removedHeaders, 10);
  assert.ok(audit.strippedFields >= 20);
  assert.equal(new URL(output.response.redirectURL).hostname, 'host-2.invalid');
  assert.equal(new URL(output.response.redirectURL).searchParams.get('param-2'), '[redacted]');
});

test('header allowlist retains only normalized structural values', () => {
  const source = entry();
  source.request.headers = [
    { name: 'Content-Type', value: 'application/json; charset="UTF-8"; secret=private' },
    { name: 'Accept', value: 'text/html, application/json;q=0.9, */*;q=0.1' },
    { name: 'Accept-Encoding', value: 'gzip, br;q=0.5' },
    { name: 'Content-Length', value: '00100' },
    { name: 'Cache-Control', value: 'max-age=60, no-store, secret=private' },
    { name: 'Pragma', value: 'no-cache' },
    { name: 'Content-Type', value: ['application/json', 'private-array-value'] },
    { name: 'Accept', value: 'application/json\r\nAuthorization: private-crlf-value' },
    { name: 'Content-Encoding', value: 'private-encoding' },
    { name: 'Content-Length', value: '100private-length' },
    { name: 'X-Unknown', value: 'private-x-value' },
    { name: 'Expires', value: 'private-expires' },
  ];
  const { har: cleaned, audit } = sanitizeHar(har([source]));
  assert.deepEqual(cleaned.log.entries[0].request.headers, [
    { name: 'content-type', value: 'application/json; charset=utf-8' },
    { name: 'accept', value: 'text/html, application/json;q=0.9, */*;q=0.1' },
    { name: 'accept-encoding', value: 'gzip, br;q=0.5' },
    { name: 'content-length', value: '100' },
    { name: 'cache-control', value: 'max-age=60, no-store' },
    { name: 'pragma', value: 'no-cache' },
  ]);
  assert.equal(audit.removedHeaders, 6);
  assert.ok(!JSON.stringify(cleaned).includes('private'));
});

test('preserveRoutes is explicit and scrubs emails, IDs, UUIDs, tokens, user info, fragments', () => {
  const source = entry();
  source.request.url = 'https://alice:password@api.example.com:8080/users/alice%40example.com/123456/550e8400-e29b-41d4-a716-446655440000/sk_live_abcdefghijklmnopqrstuvwxyz?sort=Alice&unsafe%40key=private#private-fragment';
  source.response.redirectURL = 'https://api.example.com/users/bob%2540example.com/999?token=private-redirect#private';
  const { har: cleaned } = sanitizeHar(har([source]), { preserveRoutes: true });
  const output = cleaned.log.entries[0];
  const url = new URL(output.request.url);
  assert.equal(url.host, 'api.example.com:8080');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.hash, '');
  assert.equal(decodeURIComponent(url.pathname), '/users/[redacted]/[redacted]/[redacted]/[redacted]');
  assert.equal(url.searchParams.get('sort'), '[redacted]');
  assert.deepEqual(output.request.queryString, [...url.searchParams].map(([name, value]) => ({ name, value })));
  const all = JSON.stringify(cleaned);
  for (const secret of ['alice', 'bob', '123456', '550e8400', 'abcdefghijklmnopqrstuvwxyz', 'password', 'private']) assert.ok(!all.includes(secret));
  assert.ok(all.includes('api.example.com'));
  assert.ok(!JSON.stringify(sanitizeHar(har([source]), { preserveRoutes: 'true' }).har).includes('api.example.com'));
});

test('custom terms are literal, case insensitive, deduplicated, and cover every exported string', () => {
  const source = entry();
  source.request.url = 'https://customer-secret.example.com/Customer-Secret/details/a.b%5Bc%5D?customer-secret=SECRET';
  source.request.headers = [{ name: 'Content-Type', value: 'application/json' }];
  source.response.content.mimeType = 'application/json';
  const options = { preserveRoutes: true, customTerms: ['customer-secret', 'CUSTOMER-SECRET', 'a.b[c]', 'application/json', 'TraceTidy'] };
  const { har: cleaned } = sanitizeHar(har([source]), options);
  const text = JSON.stringify(cleaned).toLowerCase();
  for (const term of options.customTerms) assert.ok(!text.includes(term.toLowerCase()), `Custom term leaked: ${term}`);
  assert.equal(cleaned.log.entries[0].response.content.mimeType, '');
  assert.deepEqual(cleaned.log.entries[0].request.headers, []);
  const url = new URL(cleaned.log.entries[0].request.url);
  assert.equal(url.hostname, 'host-1.invalid');
  assert.ok(decodeURIComponent(url.pathname).includes('[redacted]'));
  assert.throws(() => sanitizeHar(har(), { customTerms: 'secret' }), /array/);
  assert.throws(() => sanitizeHar(har(), { customTerms: [5] }), /string/);
  assert.throws(() => sanitizeHar(har(), { customTerms: ['x'.repeat(257)] }), /256/);
  assert.throws(() => sanitizeHar(har(), { customTerms: Array(101).fill('secret') }), /100/);
});

test('custom terms cannot cause replacement placeholders to leak the same term', () => {
  const source = entry();
  source.request.url = 'https://example.com/redacted?q=redacted';
  const result = sanitizeHar(har([source]), { preserveRoutes: true, customTerms: ['redacted', 'masked', 'removed'] });
  const exported = JSON.stringify(result.har).toLowerCase();
  for (const term of ['redacted', 'masked', 'removed']) assert.ok(!exported.includes(term));
  assert.equal(new URL(result.har.log.entries[0].request.url).searchParams.get('q'), '***');
});

test('custom terms fail closed when they corrupt fixed HAR structure, and later calls recover', () => {
  const original = har();
  const before = JSON.stringify(original);
  const message = 'A custom term conflicts with a structural HAR value. Use a more specific private term.';
  for (const term of ['host', 'https', 'HTTP', '1', 'GET', '2026']) {
    assert.throws(() => sanitizeHar(original, { customTerms: [term] }), (error) => {
      assert.equal(error.message, message);
      return true;
    });
    const recovered = sanitizeHar(original);
    assert.equal(recovered.har.log.version, '1.2');
    assert.equal(recovered.har.log.creator.version, '0.1.0');
    assert.equal(recovered.har.log.entries[0].request.httpVersion, 'HTTP/2.0');
    assert.equal(new URL(recovered.har.log.entries[0].request.url).hostname, 'host-1.invalid');
  }
  assert.equal(JSON.stringify(original), before);
});

test('custom replacements in routes remain encoded and query arrays follow the final URL', () => {
  const source = entry();
  source.request.url = 'https://example.com/Private%20Person/items?private-person=value&sort=private-person';
  source.response.redirectURL = 'https://example.com/Private%20Person/login?private-person=value';
  const { har: cleaned } = sanitizeHar(har([source]), { preserveRoutes: true, customTerms: ['Private Person', 'private-person', 'TraceTidy'] });
  const output = cleaned.log.entries[0];
  const parsed = new URL(output.request.url);
  assert.equal(parsed.pathname, '/%5Bredacted%5D/items');
  assert.equal(new URL(output.response.redirectURL).pathname, '/%5Bredacted%5D/login');
  assert.equal(cleaned.log.creator.name, '[redacted]');
  assert.deepEqual(output.request.queryString, [...parsed.searchParams].map(([name, value]) => ({ name, value })));
  assert.ok(!JSON.stringify(cleaned).toLowerCase().includes('private'));
  assert.throws(() => sanitizeHar(har(), { customTerms: ['%5B'] }), /structural HAR value/);
});

test('invalid URL schemes and free-form MIME values are never copied', () => {
  for (const url of ['javascript:private-script-secret', 'data:text/plain,private-inline-secret', 'not a URL private-invalid-secret']) {
    const source = entry();
    source.request.url = url;
    source.response.redirectURL = url;
    source.response.content.mimeType = { private: 'private-type-secret' };
    const cleaned = sanitizeHar(har([source])).har;
    assert.ok(!JSON.stringify(cleaned).includes('private'));
    assert.equal(new URL(cleaned.log.entries[0].request.url).hostname, 'host-1.invalid');
    assert.equal(cleaned.log.entries[0].response.content.mimeType, 'application/octet-stream');
  }
});

test('non-finite, negative, and malformed metrics produce bounded numeric output', () => {
  const source = entry({
    startedDateTime: 'private-invalid-date', time: Infinity,
    timings: { blocked: -999, dns: 'private-dns', connect: Infinity, send: -100, wait: NaN, receive: 1e100, ssl: -20 },
  });
  source.response.status = 'private-status';
  source.response.bodySize = -500;
  source.response.content.size = Infinity;
  source.request.headersSize = 'private-size';
  const original = har([source]);
  const cleaned = sanitizeHar(original).har;
  const output = cleaned.log.entries[0];
  assert.equal(output.startedDateTime, '1970-01-01T00:00:00.000Z');
  assert.equal(output.response.status, 0);
  assert.equal(output.response.bodySize, -1);
  assert.equal(output.response.content.size, 0);
  assert.equal(output.request.headersSize, -1);
  assert.equal(output.timings.blocked, -1);
  assert.equal(output.timings.send, 0);
  const summary = summarizeHar(original);
  assert.equal(summary.entries[0].startOffset, 0);
  for (const value of Object.values(summary)) if (typeof value === 'number') assert.ok(Number.isFinite(value) && value >= 0);
  for (const value of Object.values(output.timings)) assert.ok(Number.isFinite(value));
  assert.ok(!JSON.stringify(cleaned).includes('private'));
});

test('summary preserves timeline order, detects failures, and accounts for body-size fallback', () => {
  const one = entry({ startedDateTime: '2026-01-02T03:04:05.300Z', time: 80 });
  const two = entry({ startedDateTime: '2026-01-02T03:04:05.000Z', time: 200 });
  two.request.url = 'https://other.example.com/api';
  two.response.status = 503;
  two.response.bodySize = -1;
  two.response.content.size = 200;
  const three = entry({ startedDateTime: 'invalid date', time: 10 });
  three.response.status = 0;
  three.response.bodySize = 0;
  const summary = summarizeHar(har([one, two, three]));
  assert.equal(summary.requestCount, 3);
  assert.equal(summary.failureCount, 2);
  assert.equal(summary.totalBytes, 712);
  assert.equal(summary.durationMs, 380);
  assert.equal(summary.slowestMs, 200);
  assert.equal(summary.hostCount, 2);
  assert.deepEqual(summary.entries.map((item) => item.startOffset), [300, 0, 0]);
  assert.deepEqual(summary.entries.map((item) => item.failed), [false, true, true]);
  assert.deepEqual(summary.entries.map((item) => item.index), [0, 1, 2]);
  assert.equal(summary.entries[1].path, '/api');
});

test('report uses sanitized topology, escapes Markdown, and excludes original secrets', () => {
  const source = entry();
  source.response.status = 500;
  source.request.postData = { text: 'REPORT_PRIVATE_BODY' };
  source.request.url = 'https://REPORT_PRIVATE_HOST.invalid/REPORT_PRIVATE_PATH?secret=REPORT_PRIVATE_QUERY';
  const { har: cleaned } = sanitizeHar(har([source]));
  const report = buildReport(cleaned, { title: '<img src=x onerror=alert(1)>\n# Unexpected', notes: 'Observe [link](javascript:alert(1)) and | tables |.' });
  for (const secret of ['REPORT_PRIVATE_BODY', 'REPORT_PRIVATE_HOST', 'REPORT_PRIVATE_PATH', 'REPORT_PRIVATE_QUERY']) assert.ok(!report.includes(secret));
  assert.match(report, /host\\-1/);
  assert.match(report, /Requests: 1/);
  assert.match(report, /Failed requests: 1/);
  assert.ok(!report.includes('<img'));
  assert.ok(report.includes('&lt;img'));
  assert.ok(!report.includes('[link](javascript:'));
  assert.ok(report.includes('\\[link\\]'));
  assert.match(report, /Sharing review/);
});
