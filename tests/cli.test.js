import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/tracetidy.js', import.meta.url));
const PRIVATE = 'private-demo-value';
const fixture = {
  log: { version: '1.2', creator: { name: 'test', version: '1' }, entries: [{
    startedDateTime: '2026-01-01T00:00:00.000Z', time: 125,
    request: { method: 'GET', url: `https://internal-secret.example/private-user/profile?token=${PRIVATE}`, httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Authorization', value: `Bearer ${PRIVATE}` }], queryString: [{ name: 'token', value: PRIVATE }], cookies: [{ name: 'session', value: PRIVATE }], headersSize: -1, bodySize: 0 },
    response: { status: 500, statusText: 'Server Error', httpVersion: 'HTTP/1.1', headers: [{ name: 'Set-Cookie', value: PRIVATE }], cookies: [{ name: 'session', value: PRIVATE }],
      content: { size: 100, mimeType: 'application/json', text: `{"secret":"${PRIVATE}"}` }, redirectURL: '', headersSize: -1, bodySize: 100 },
    cache: {}, timings: { blocked: 0, dns: 5, connect: 10, send: 1, wait: 99, receive: 10 },
  }] },
};

async function workspace(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'tracetidy-cli-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, 'input.har'), JSON.stringify(fixture));
  return cwd;
}

function run(cwd, args, input) { return spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: 'utf8' }); }

test('CLI exports one sanitized snapshot and aggregate-only stderr', async (t) => {
  const cwd = await workspace(t);
  const result = run(cwd, ['input.har', '--output', 'safe.har', '--report', 'issue.md', '--audit', 'audit.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const safe = await fs.readFile(path.join(cwd, 'safe.har'), 'utf8');
  const report = await fs.readFile(path.join(cwd, 'issue.md'), 'utf8');
  const audit = JSON.parse(await fs.readFile(path.join(cwd, 'audit.json'), 'utf8'));
  assert.equal(JSON.parse(safe).log.entries.length, 1);
  for (const text of [safe, report, result.stderr, JSON.stringify(audit)]) {
    assert.ok(!text.includes(PRIVATE));
    assert.ok(!text.includes('internal-secret.example'));
    assert.ok(!text.includes('private-user'));
  }
  assert.match(result.stderr, /1 requests/);
  assert.ok(audit.removedBodies >= 1);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(cwd, 'safe.har'))).mode & 0o777, 0o600);
});

test('stdin defaults to JSON stdout', async (t) => {
  const cwd = await workspace(t);
  const result = run(cwd, ['-'], JSON.stringify(fixture));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).log.entries.length, 1);
  assert.ok(!result.stdout.includes(PRIVATE));
  assert.match(result.stderr, /sanitized export ready/);
});

test('existing output requires --force and original input is never replaced', async (t) => {
  const cwd = await workspace(t);
  await fs.writeFile(path.join(cwd, 'safe.har'), 'keep me');
  assert.equal(run(cwd, ['input.har', '-o', 'safe.har']).status, 2);
  assert.equal(await fs.readFile(path.join(cwd, 'safe.har'), 'utf8'), 'keep me');
  assert.equal(run(cwd, ['input.har', '-o', 'safe.har', '--force']).status, 0);
  const before = await fs.readFile(path.join(cwd, 'input.har'), 'utf8');
  assert.equal(run(cwd, ['input.har', '-o', './input.har', '--force']).status, 2);
  assert.equal(await fs.readFile(path.join(cwd, 'input.har'), 'utf8'), before);
});

test('symlinks and hardlinks cannot bypass input preservation', async (t) => {
  const cwd = await workspace(t);
  await fs.symlink('input.har', path.join(cwd, 'alias.har'));
  await fs.link(path.join(cwd, 'input.har'), path.join(cwd, 'hardlink.har'));
  for (const output of ['alias.har', 'hardlink.har']) {
    const result = run(cwd, ['input.har', '-o', output, '--force']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  }
  await fs.mkdir(path.join(cwd, 'linked-parent'));
  await fs.symlink('linked-parent', path.join(cwd, 'parent-alias'));
  await fs.writeFile(path.join(cwd, 'linked-parent', 'source.har'), JSON.stringify(fixture));
  assert.equal(run(cwd, ['linked-parent/source.har', '-o', 'parent-alias/source.har', '--force']).status, 2);
});

test('output paths must be distinct and preflight does not leave partial output', async (t) => {
  const cwd = await workspace(t);
  const result = run(cwd, ['input.har', '--output', 'same.json', '--audit', './same.json']);
  assert.equal(result.status, 2);
  await assert.rejects(fs.stat(path.join(cwd, 'same.json')), { code: 'ENOENT' });
  await fs.writeFile(path.join(cwd, 'audit.json'), 'existing');
  assert.equal(run(cwd, ['input.har', '--output', 'safe.har', '--audit', 'audit.json']).status, 2);
  await assert.rejects(fs.stat(path.join(cwd, 'safe.har')), { code: 'ENOENT' });
});

test('invalid input and options never echo sensitive contents', async (t) => {
  const cwd = await workspace(t);
  const cases = [
    { args: ['-'], input: `{"secret":"${PRIVATE}"}` },
    { args: ['-'], input: `${PRIVATE} is not JSON` },
    { args: ['input.har', `--${PRIVATE}`] },
    { args: ['input.har', '--output'] },
    { args: ['input.har', '--term', 'x'.repeat(257)] },
    { args: ['input.har', ...Array.from({ length: 101 }, () => ['--term', PRIVATE]).flat()] },
    { args: [] },
  ];
  for (const item of cases) {
    const result = run(cwd, item.args, item.input);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(PRIVATE));
  }
  assert.equal(run(cwd, ['missing.har']).status, 1);
});

test('help works without input and preserved routes are an explicit warning', async (t) => {
  const cwd = await workspace(t);
  const help = run(cwd, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--preserve-routes/);
  const result = run(cwd, ['input.har', '--preserve-routes', '--term', 'private-user']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('private-user'));
  assert.match(result.stderr, /preserved routes can contain identifying/);
  assert.ok(!result.stderr.includes('internal-secret.example'));
});
