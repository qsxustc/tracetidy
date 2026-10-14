# Performance and reproducible workloads

TraceTidy processes HAR data in memory. The browser accepts files up to **25 MiB**; the shared HAR core limits source text to **50 MiB**, requests to **50,000**, and each URL to **32 KiB**. Those are admission limits, not promises about memory use or processing speed. Parsed objects, sanitized objects, summaries, report text, and export strings can occupy substantially more memory than the source file.

## Run the synthetic core benchmark

The benchmark uses only Node.js built-ins and the project's own modules. It creates synthetic data in memory, performs no network requests, and does not write HAR files to disk.

```bash
npm run benchmark
npm run benchmark -- --requests 1000

# Equivalent direct invocation, without package scripts:
node scripts/benchmark.js --requests 10000
```

The default workload has 10,000 requests, each with a 1,800-byte ASCII response body. It uses fixed timestamps, repeated synthetic endpoints under `benchmark.invalid`, finite timings, and some HTTP 401 and 500 responses. Endpoint identity and body contents are deterministic; execution timings vary by machine and runtime.

`--requests` accepts an integer from 1 through 50,000. Larger generated workloads can exceed the core's 50 MiB source limit before reaching the request-count limit. The benchmark then stops with a concise error; it does not bypass the application's limits. The default workload is intended to be near the browser's supported large-file range. Check the printed input size when choosing another count.

The script prints input and output byte sizes, the Node.js version and platform, and elapsed milliseconds for:

- Validation and JSON parsing.
- Summarizing the original recording.
- Sanitizing with default endpoint aliases.
- Analyzing the sanitized recording.
- Generating a report from the sanitized recording.
- Serializing the HAR and audit export text.

This is a single local pass with no warm-up or average over repeated runs. Fixture generation, disk I/O, ZIP creation, Worker startup and messaging, browser rendering, and UI responsiveness are excluded. The report builder performs its own summary and analysis; adding the printed stages does not reproduce the browser's cached processing path. Use this benchmark to compare core costs on the same machine and Node.js version, with the same request count. It does not establish browser latency or an acceleration percentage.

## Browser processing design

The current optimization uses a dedicated module Web Worker for parsing, sanitization, analysis, report generation, and ZIP preparation. The Worker keeps the original capture and returns one browser-memory copy for private inspection, plus summaries and the share snapshot. Clearing a session or replacing a trace terminates the previous worker and rejects obsolete results.

A share snapshot is intended to retain the sanitized HAR, report, audit, and export text for the current set of redaction options. Changing tabs or downloading an existing snapshot should reuse that work. Changing custom terms, route-preservation settings, or report details requires a new snapshot; exports must wait for that snapshot to succeed.

The request view is intended to cache filtered and sorted indices for the active search, filter, and sort. Selecting another row or changing pages should not repeat filtering and sorting for the whole recording. Search normalization can be prepared when the trace loads rather than recomputed for every interaction.

These descriptions explain the architecture of this revision. The Node.js benchmark above does **not** verify the browser integration. Browser responsiveness and cancellation require separate browser checks on the final build before a release describes them as verified.

## Browser verification checklist

The v0.2 browser integration was checked with a synthetic **23.15 MiB / 10,000-request** recording in the Codex in-app browser on macOS. Import showed all 10,000 requests while rendering 50 rows per page; pagination and the latest redaction snapshot worked. Editing sharing rules disabled exports immediately. Clearing during a new redaction removed the recording, and no obsolete result reappeared. The demo workflow also verified triage filters, endpoint groups, request keyboard focus, authored report context and a real ZIP download with valid CRCs and no planted HAR secrets.

These checks establish behavior for those workloads and that environment. They are not a measured frame-rate result, a broad browser compatibility claim, or an end-to-end speed benchmark. Download automation latency was not used as an application performance metric.

Use synthetic captures and record the browser version, device, file size, and request count. A useful release check covers:

- Import a capture close to the 25 MiB browser limit; verify that busy status appears and the UI can still respond while processing.
- Clear a session during loading or redaction; verify that old data cannot reappear when a delayed operation finishes.
- Change redaction settings rapidly; verify that obsolete previews and downloads cannot win over the latest settings.
- Switch tabs, select rows, paginate, and repeatedly download a successful snapshot; verify that those actions reuse the expected caches.
- Check the generated ZIP and its HAR, report, and audit against the currently displayed sharing options.

Do not infer these results from the core benchmark or from a simulated Worker. Publish any browser measurements separately with their environment and workload details.
