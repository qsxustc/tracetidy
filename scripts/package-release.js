#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const GENERATED_DIRECTORIES = new Set(['.git', '.openai', 'dist', 'node_modules', 'artifacts', 'release-artifacts']);
const STATIC_ROOTS = new Set(['src', 'public', 'samples']);
const HELP = `Package a TraceTidy release using tracked public files only.

Usage:
  node scripts/package-release.js [--output-dir <directory>] [--force]

Requires Node.js 20+, Git, tar, a clean tracked working tree, and npm run build.
The default output is ../release-artifacts/tracetidy-v<VERSION>.
Creates source/web .tar.gz archives, SHA256SUMS and release-manifest.json.
Only samples/demo.har is allowed as a HAR fixture. Untracked files, generated
directories and hosting metadata are excluded. Symlinks and credential-like
filenames are rejected. The static build must match tracked static sources.
Existing output files are refused unless --force is supplied. --force replaces
only the four generated files; it never removes the output directory.
`;

export class ReleaseError extends Error {}

function fail(message) { throw new ReleaseError(message); }

function parseArgs(args) {
  const options = {};
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force' && !options.force) options.force = true;
    else if (arg === '--output-dir' && !options.outputDir && args[index + 1] && !args[index + 1].startsWith('--')) {
      options.outputDir = args[++index];
    } else fail('Unknown or repeated argument. Use --help for usage.');
  }
  return options;
}

async function run(command, args, cwd) {
  try { return (await runFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })).stdout; }
  catch { fail(`${command} failed. Verify that it is installed and the repository/build is available.`); }
}

async function assertClean(root) {
  const status = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=no'], root);
  if (status) fail('Tracked files have uncommitted changes. Commit the release changes, then build and package that commit.');
}

function isPublicPath(name) {
  const parts = name.split('/');
  if (!name || path.posix.isAbsolute(name) || parts.some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f\\]/.test(name)) {
    fail('A tracked path is not safe to archive.');
  }
  if (parts.some(part => GENERATED_DIRECTORIES.has(part)) || parts.at(-1) === '.DS_Store') return false;
  const lower = name.toLowerCase();
  if (parts.some(part => /^\.env(?:\.|$)/i.test(part) || /^\.(?:aws|ssh)$/i.test(part) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(part) ||
      /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(part)) ||
      /\.(?:private(?:\.[^.]+)?|pem|key|p12|pfx|keystore)$/i.test(name)) {
    fail('A credential-like tracked filename was found. Remove it from the public release input.');
  }
  if (lower.endsWith('.har') && name !== 'samples/demo.har') {
    fail('Only the tracked synthetic samples/demo.har fixture may be included in a release.');
  }
  return true;
}

async function checkedFile(root, relative) {
  let cursor = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    let info;
    try { info = await lstat(cursor); }
    catch { fail('A release input is missing. Build again from the clean release commit.'); }
    if (info.isSymbolicLink()) fail('Symbolic links are not allowed in release inputs.');
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
      fail('Release inputs must be regular files inside ordinary directories.');
    }
  }
  return cursor;
}

async function staticFiles(directory, prefix = '') {
  let info;
  try { info = await lstat(directory); }
  catch { fail('dist is missing. Run npm run build before packaging.'); }
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Static build directories must be ordinary directories.');
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail('Symbolic links are not allowed in the static build.');
    if (entry.isDirectory()) files.push(...await staticFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else fail('The static build contains a non-regular file.');
  }
  return files.sort();
}

async function copySelected(root, names, destination) {
  for (const relative of names) {
    const input = await checkedFile(root, relative);
    const output = path.join(destination, relative);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(input, output);
  }
}

async function checkOutputFile(filename, force) {
  let info;
  try { info = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) fail('An output path exists and is not a regular file. Choose another output directory.');
  if (!force) fail('Release outputs already exist. Choose another output directory or use --force to replace generated files only.');
}

/** Create release files without updating any Git refs or publishing remotely. */
export async function packageRelease({ root = projectRoot, outputDir, force = false } = {}) {
  root = await realpath(path.resolve(root));
  await assertClean(root);
  const commit = (await run('git', ['rev-parse', 'HEAD'], root)).trim();
  const gitRoot = (await run('git', ['rev-parse', '--show-toplevel'], root)).trim();
  if (path.resolve(gitRoot) !== root) fail('Run packaging from the root of the TraceTidy Git repository.');
  const packageJson = JSON.parse(await readFile(await checkedFile(root, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('The package version must be a stable major.minor.patch release.');
  if (packageJson.name !== 'tracetidy') fail('This packager is intended for the TraceTidy repository.');
  const tracked = (await run('git', ['ls-files', '-z'], root)).split('\0').filter(Boolean);
  const publicFiles = tracked.filter(isPublicPath).sort();
  for (const required of ['package.json', 'LICENSE', 'README.md', 'index.html', 'samples/demo.har']) {
    if (!publicFiles.includes(required)) fail('A required public release input is not tracked by Git.');
  }
  const expectedStatic = publicFiles.filter(name => name === 'index.html' || STATIC_ROOTS.has(name.split('/')[0]));
  const actualStatic = await staticFiles(path.join(root, 'dist'));
  if (JSON.stringify(actualStatic) !== JSON.stringify(expectedStatic)) {
    fail('The static build contains missing or extra files. Run npm run build and remove untracked static inputs.');
  }
  for (const relative of expectedStatic) {
    const original = await readFile(await checkedFile(root, relative));
    const built = await readFile(await checkedFile(path.join(root, 'dist'), relative));
    if (!original.equals(built)) fail('The static build is stale or differs from the tracked source. Run npm run build again.');
  }
  // Check every source before creating an output directory or any archive.
  for (const relative of publicFiles) await checkedFile(root, relative);

  const destination = path.resolve(outputDir ?? path.join(root, '..', 'release-artifacts', `tracetidy-v${version}`));
  await mkdir(destination, { recursive: true });
  const destinationInfo = await lstat(destination);
  if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()) fail('The output directory must be an ordinary directory.');
  const archiveNames = [`tracetidy-v${version}-source.tar.gz`, `tracetidy-v${version}-web.tar.gz`];
  const outputNames = [...archiveNames, 'SHA256SUMS', 'release-manifest.json'];
  for (const name of outputNames) await checkOutputFile(path.join(destination, name), force);

  // Keep publication files on the destination filesystem for atomic no-overwrite links.
  const staging = await mkdtemp(path.join(destination, '.tracetidy-release-'));
  try {
    const sourceName = `tracetidy-${version}`;
    await copySelected(root, publicFiles, path.join(staging, sourceName));
    await copySelected(path.join(root, 'dist'), expectedStatic, path.join(staging, 'web'));
    await copySelected(root, ['LICENSE'], path.join(staging, 'web'));
    await assertClean(root);
    if ((await run('git', ['rev-parse', 'HEAD'], root)).trim() !== commit) fail('The release commit changed during packaging. Retry on the intended commit.');

    // Pass arguments directly: repository paths and output paths never become shell text.
    await run('tar', ['-czf', path.join(staging, archiveNames[0]), '-C', staging, sourceName], root);
    await run('tar', ['-czf', path.join(staging, archiveNames[1]), '-C', path.join(staging, 'web'), ...[...expectedStatic, 'LICENSE'].sort()], root);
    const artifacts = [];
    for (const name of archiveNames) {
      const contents = await readFile(path.join(staging, name));
      artifacts.push({ name, size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
    }
    await writeFile(path.join(staging, 'SHA256SUMS'), `${artifacts.map(item => `${item.sha256}  ${item.name}`).join('\n')}\n`);
    const manifest = { version, commit, artifacts };
    await writeFile(path.join(staging, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const name of outputNames) {
      const output = path.join(destination, name);
      await checkOutputFile(output, force);
      if (force) await rename(path.join(staging, name), output);
      else {
        try { await link(path.join(staging, name), output); }
        catch (error) { if (error.code === 'EEXIST') fail('An output appeared during packaging. Existing outputs were not replaced.'); throw error; }
      }
    }
    return { ...manifest, outputDir: destination };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else {
      const result = await packageRelease(options);
      process.stdout.write(`TraceTidy v${result.version} packaged from ${result.commit}\n${result.outputDir}\n`);
      for (const artifact of result.artifacts) process.stdout.write(`${artifact.name}: ${artifact.size} bytes, SHA-256 ${artifact.sha256}\n`);
    }
  } catch (error) {
    process.stderr.write(`TraceTidy release: ${error instanceof ReleaseError ? error.message : 'Packaging failed. Check repository access, available disk space and output permissions.'}\n`);
    process.exitCode = 1;
  }
}
