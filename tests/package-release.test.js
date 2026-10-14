import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageRelease } from '../scripts/package-release.js';

const runFile = promisify(execFile);
const staticNames = ['index.html', 'src/app.js', 'src/trace-worker.js', 'public/icon.svg', 'samples/demo.har'];

async function commit(root) {
  await runFile('git', ['add', '--', '.'], { cwd: root });
  await runFile('git', ['-c', 'user.name=TraceTidy release test', '-c', 'user.email=release-test@example.invalid', 'commit', '--quiet', '-m', 'Synthetic release fixture'], { cwd: root });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tracetidy-package-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  await mkdir(root);
  const files = {
    '.gitignore': 'dist/\n*.private.har\n',
    'package.json': `${JSON.stringify({ name: 'tracetidy', version: '0.2.0', type: 'module', license: 'MIT' })}\n`,
    'LICENSE': 'MIT fixture\n',
    'README.md': 'Synthetic source fixture\n',
    'index.html': '<!doctype html><script type="module" src="./src/app.js"></script>\n',
    'src/app.js': 'export const synthetic = true;\n',
    'src/trace-worker.js': 'self.onmessage = () => {};\n',
    'public/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'samples/demo.har': '{"log":{"entries":[],"creator":{"name":"synthetic fixture"}}}\n',
    '.openai/hosting.json': '{"fixture":"excluded hosting metadata"}\n',
  };
  for (const [name, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), value);
  }
  await runFile('git', ['init', '--quiet'], { cwd: root });
  await commit(root);
  const dist = path.join(root, 'dist');
  for (const name of staticNames) {
    await mkdir(path.dirname(path.join(dist, name)), { recursive: true });
    await cp(path.join(root, name), path.join(dist, name));
  }
  return { root, dist, outputDir: path.join(directory, 'output') };
}

test('release archives contain tracked public files only and hashes identify actual bytes', async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.root, 'customer.private.har'), 'UNTRACKED_PRIVATE_FIXTURE');
  await writeFile(path.join(options.root, '.env.local'), 'UNTRACKED_ENV_FIXTURE');
  const result = await packageRelease(options);
  assert.equal(result.version, '0.2.0');
  assert.match(result.commit, /^[a-f0-9]{40,64}$/);
  const source = result.artifacts.find(item => item.name.endsWith('-source.tar.gz'));
  const web = result.artifacts.find(item => item.name.endsWith('-web.tar.gz'));
  const sourceNames = (await runFile('tar', ['-tzf', path.join(options.outputDir, source.name)])).stdout.trim().split('\n');
  assert.ok(sourceNames.includes('tracetidy-0.2.0/README.md'));
  assert.ok(sourceNames.includes('tracetidy-0.2.0/samples/demo.har'));
  assert.ok(sourceNames.every(name => name.startsWith('tracetidy-0.2.0/')));
  assert.ok(!sourceNames.some(name => /(?:\.git\/|\.openai|dist\/|private|\.env)/.test(name)));
  const webNames = (await runFile('tar', ['-tzf', path.join(options.outputDir, web.name)])).stdout.trim().split('\n').sort();
  assert.deepEqual(webNames, [...staticNames, 'LICENSE'].sort());
  const extracted = path.join(options.outputDir, 'extracted');
  await mkdir(extracted);
  await runFile('tar', ['-xzf', path.join(options.outputDir, web.name), '-C', extracted]);
  for (const name of staticNames) assert.deepEqual(await readFile(path.join(extracted, name)), await readFile(path.join(options.dist, name)));
  assert.deepEqual(await readFile(path.join(extracted, 'LICENSE')), await readFile(path.join(options.root, 'LICENSE')));
  for (const artifact of result.artifacts) {
    const bytes = await readFile(path.join(options.outputDir, artifact.name));
    assert.equal(artifact.size, bytes.length);
    assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  const manifest = JSON.parse(await readFile(path.join(options.outputDir, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { version: result.version, commit: result.commit, artifacts: result.artifacts });
  assert.deepEqual(Object.keys(manifest).sort(), ['artifacts', 'commit', 'version']);
  const sums = await readFile(path.join(options.outputDir, 'SHA256SUMS'), 'utf8');
  assert.equal(sums, `${result.artifacts.map(item => `${item.sha256}  ${item.name}`).join('\n')}\n`);
});

test('release packaging refuses a dirty tracked tree before creating outputs', async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.root, 'README.md'), 'Uncommitted fixture change\n');
  await assert.rejects(packageRelease(options), /uncommitted changes/);
  await assert.rejects(lstat(options.outputDir), { code: 'ENOENT' });
});

test('release packaging rejects tracked credential-like files and non-demo HARs', async t => {
  for (const name of ['.env.local', 'config/credentials.json', 'notes.private.txt', 'samples/customer.har', '.ssh/id_ed25519']) {
    const options = await fixture(t);
    await mkdir(path.dirname(path.join(options.root, name)), { recursive: true });
    await writeFile(path.join(options.root, name), 'SYNTHETIC_REJECTION_FIXTURE');
    await commit(options.root);
    await assert.rejects(packageRelease(options), /credential-like|Only the tracked synthetic/);
    await assert.rejects(lstat(options.outputDir), { code: 'ENOENT' });
  }
});

test('release packaging rejects source and static-build symlinks', async t => {
  const options = await fixture(t);
  const linkName = path.join(options.root, 'linked-readme.md');
  await symlink('README.md', linkName);
  await commit(options.root);
  await assert.rejects(packageRelease(options), /Symbolic links/);
  await rm(linkName);
  await commit(options.root);
  await rm(path.join(options.dist, 'src/app.js'));
  await symlink('../../src/app.js', path.join(options.dist, 'src/app.js'));
  await assert.rejects(packageRelease(options), /Symbolic links/);
});

test('release packaging requires a complete static build identical to tracked sources', async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.dist, 'customer.private.har'), 'SYNTHETIC_REJECTION_FIXTURE');
  await assert.rejects(packageRelease(options), /missing or extra files/);
  await rm(path.join(options.dist, 'customer.private.har'));
  await writeFile(path.join(options.dist, 'src/app.js'), 'STALE_SYNTHETIC_BUILD');
  await assert.rejects(packageRelease(options), /stale or differs/);
  await rm(options.dist, { recursive: true });
  await assert.rejects(packageRelease(options), /dist is missing/);
});

test('release packaging does not overwrite by default; force preserves unrelated files and refuses output symlinks', async t => {
  const options = await fixture(t);
  const first = await packageRelease(options);
  const sourceName = first.artifacts.find(item => item.name.endsWith('-source.tar.gz')).name;
  await writeFile(path.join(options.outputDir, 'keep-me.txt'), 'UNRELATED_FIXTURE');
  await assert.rejects(packageRelease(options), /already exist/);
  await packageRelease({ ...options, force: true });
  assert.equal(await readFile(path.join(options.outputDir, 'keep-me.txt'), 'utf8'), 'UNRELATED_FIXTURE');
  await rm(path.join(options.outputDir, sourceName));
  await symlink('keep-me.txt', path.join(options.outputDir, sourceName));
  await assert.rejects(packageRelease({ ...options, force: true }), /not a regular file/);
  assert.equal(await readFile(path.join(options.outputDir, 'keep-me.txt'), 'utf8'), 'UNRELATED_FIXTURE');
});
