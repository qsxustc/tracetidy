#!/usr/bin/env node
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateHar, sanitizeHar, summarizeHar, buildReport } from '../src/har.js';

const HELP = `TraceTidy — make a safer HAR before sharing a bug report.

Usage:
  node bin/tracetidy.js <input.har | -> [options]

Options:
  --output, -o <file>   Write sanitized HAR (otherwise writes to stdout)
  --report <file>       Write a Markdown issue report from the sanitized HAR
  --audit <file>        Write aggregate redaction counts as JSON
  --term <value>        Redact an additional private value; repeat as needed
  --preserve-routes    Keep scrubbed hostnames, paths, and query names
  --force              Replace existing output files, never the input
  --help, -h           Show this help

Examples:
  node bin/tracetidy.js samples/demo.har --output safe.har --report issue.md
  cat input.har | node bin/tracetidy.js - > safe.har
  node bin/tracetidy.js input.har --output safe.har --audit audit.json --term "Private Project"

Default exports use stable aliases for hosts, paths, and query names.
--preserve-routes may expose identifying route or domain information.
Extra terms passed as arguments may be visible in shell history/process lists.
No network requests are made. Review every export before sharing.

Exit codes: 0 success; 1 I/O or processing error; 2 invalid arguments or HAR.
`;

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

function parseArgs(args) {
  const options = { customTerms: [], preserveRoutes: false, force: false };
  let positionalOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && (arg === '--help' || arg === '-h')) return { help: true };
    if (!positionalOnly && arg === '--force') { options.force = true; continue; }
    if (!positionalOnly && arg === '--preserve-routes') { options.preserveRoutes = true; continue; }
    const valueFlags = { '--output': 'output', '-o': 'output', '--report': 'report', '--audit': 'audit', '--term': 'term' };
    if (!positionalOnly && Object.hasOwn(valueFlags, arg)) {
      const value = args[++i];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new CliError('An option is missing its value. Use --help for usage.', 2);
      }
      const key = valueFlags[arg];
      if (key === 'term') {
        if (value.trim().length > 256 || options.customTerms.length >= 100) {
          throw new CliError('Use at most 100 private terms of at most 256 characters each.', 2);
        }
        options.customTerms.push(value);
      }
      else {
        if (options[key] !== undefined) throw new CliError('An output option was supplied more than once.', 2);
        options[key] = value;
      }
      continue;
    }
    if (!positionalOnly && arg.startsWith('-') && arg !== '-') {
      throw new CliError('Unknown option. Use --help for usage.', 2);
    }
    if (options.input !== undefined) throw new CliError('Provide exactly one input HAR.', 2);
    options.input = arg;
  }
  if (!options.input) throw new CliError('An input HAR is required. Use --help for usage.', 2);
  return options;
}

async function lstatIfExists(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }

async function inspectOutput(file, input, force) {
  const absolute = path.resolve(file);
  const parent = await fs.realpath(path.dirname(absolute));
  const canonical = path.join(parent, path.basename(absolute));
  const stat = await lstatIfExists(canonical);
  if (canonical === input?.canonical || sameFile(stat, input?.stat)) {
    throw new CliError('Output must not replace the original input HAR, even with --force.', 2);
  }
  if (stat?.isSymbolicLink()) throw new CliError('Output paths must not be symbolic links.', 2);
  if (stat && !stat.isFile()) throw new CliError('Output paths must be regular files.', 2);
  if (stat && !force) throw new CliError('An output already exists. Choose another path or use --force.', 2);
  return { canonical, stat };
}

async function writeOutputs(outputs, input, force) {
  const targets = [];
  for (const output of outputs) {
    const target = await inspectOutput(output.file, input, force);
    if (targets.some((other) => other.canonical === target.canonical || sameFile(other.stat, target.stat))) {
      throw new CliError('HAR, report, and audit outputs must use different files.', 2);
    }
    targets.push({ ...target, content: output.content });
  }
  const staged = [];
  try {
    for (const target of targets) {
      const temporary = path.join(path.dirname(target.canonical), `.tracetidy-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      staged.push({ ...target, temporary });
      try { await handle.writeFile(target.content, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    }
    for (const target of staged) {
      await inspectOutput(target.canonical, input, force);
      if (force) await fs.rename(target.temporary, target.canonical);
      else {
        // A hard link installs the completed file without an overwrite race.
        await fs.link(target.temporary, target.canonical);
        await fs.unlink(target.temporary);
      }
    }
  } finally {
    await Promise.allSettled(staged.map(({ temporary }) => fs.unlink(temporary)));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  let input;
  let raw;
  if (options.input === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    const canonical = await fs.realpath(path.resolve(options.input));
    const stat = await fs.stat(canonical);
    if (!stat.isFile()) throw new CliError('The input must be a regular HAR file.', 2);
    input = { canonical, stat };
    raw = await fs.readFile(canonical, 'utf8');
  }
  let har;
  try { har = validateHar(raw); }
  catch { throw new CliError('Invalid HAR. Expected a HAR JSON object with a log.entries array.', 2); }
  const result = sanitizeHar(har, { customTerms: options.customTerms, preserveRoutes: options.preserveRoutes });
  const sanitized = `${JSON.stringify(result.har, null, 2)}\n`;
  const outputs = [];
  if (options.output) outputs.push({ file: options.output, content: sanitized });
  if (options.report) outputs.push({ file: options.report, content: buildReport(result.har, { title: 'Network issue report', notes: '' }) });
  if (options.audit) outputs.push({ file: options.audit, content: `${JSON.stringify(result.audit, null, 2)}\n` });
  await writeOutputs(outputs, input, options.force);
  if (!options.output) process.stdout.write(sanitized);
  const summary = summarizeHar(result.har);
  process.stderr.write(`TraceTidy: ${summary.requestCount} requests, ${summary.failureCount} HTTP failures, ${summary.totalBytes} bytes; sanitized export ready.\n`);
  if (options.preserveRoutes) process.stderr.write('Warning: preserved routes can contain identifying hostnames or paths. Review before sharing.\n');
}

main().catch((error) => {
  // Never echo exception details, input paths, URLs, or HAR snippets.
  const message = error instanceof CliError ? error.message : 'Unable to read, process, or write the HAR. Check file access and output directories.';
  process.stderr.write(`TraceTidy: ${message}\n`);
  process.exitCode = error instanceof CliError ? error.code : 1;
});
