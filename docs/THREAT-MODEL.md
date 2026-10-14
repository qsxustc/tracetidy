# TraceTidy threat model

## v0.2 browser processing boundary

The browser uses a same-origin module Web Worker for parsing, analysis, redaction, report text and ZIP creation. The original HAR is kept in Worker memory and a single browser-memory copy for the private inspector. It is not written to browser storage. Replacing or clearing a recording terminates the Worker and rejects pending operations; the UI also checks its session generation before accepting file reads or results.

Sharing rules and report fields invalidate the current export immediately. Only the newest successful snapshot enables downloads; HAR, Markdown and audit text in a ZIP come from that snapshot. Worker failure does not fall back to processing private content in a remote service.

User-written report titles and reproduction notes are **included as entered**. Custom HAR redaction terms do not scrub them. The UI and generated report warn about this boundary; the audit records whether author notes were included without recording their contents.

## Purpose and scope

TraceTidy reduces accidental disclosure when developers share browser HAR captures. It parses the file locally, retains an explicit subset of HAR fields, removes sensitive material, and creates an export for human review. It is a deterministic heuristic tool, not a formal anonymizer, a secrets scanner with complete detection, or a compliance certification.

This document describes the local browser app and CLI. It does not describe future paid services. Supported input is HAR JSON; PDF, screenshots, video, and OCR are outside the scope.

## What we protect

The primary assets are authentication credentials, cookies, payload contents, personal details, private endpoint identities, and the original trace. The principal risk is a helpful developer accidentally attaching those details to an issue, chat, or support ticket.

The relevant adversary is a recipient who can read the exported files, or someone who can read a public bug report. The tool does not defend against a compromised device, a malicious browser extension, an altered build, hostile local filesystem manipulation, or someone already able to read the original HAR.

## Data flow and trust boundaries

1. The user selects a local HAR in the browser or gives the CLI a file/stdin stream.
2. Validation checks that the input has a HAR `log.entries` array.
3. Original requests can be inspected privately in the browser. This view is sensitive.
4. The shared core sanitizer produces a new HAR object using an explicit allowlist. Private terms supplied by the user augment its rules.
5. The issue report is generated from that sanitized object, and the audit records aggregate change counts.
6. The user reviews and chooses where to share the outputs.

The application does not upload HAR contents, call an AI service, or require an account. Local processing is not a promise about a user's host browser, extensions, cloud-synced directories, shell tooling, or a modified copy of the app. A hosted copy requires trust in the code that the hosting origin serves; users with a stronger requirement should run a reviewed local checkout.

## Redaction behavior

The sanitizer discards request and response bodies, cookies, sensitive headers, and unrecognized HAR fields. Query values and common sensitive strings are masked. An explicit allowlist keeps unknown extension fields from quietly carrying arbitrary payloads into the export.

By default, hostnames, routes, and query parameter names are generalized into stable aliases. Stable aliases preserve relationships within one trace; they do not preserve the original route meaning. There is no exported mapping back to the original values.

The optional route-preservation setting keeps hostnames, paths, and parameter names after the ordinary value rules and private-term checks. That setting can reveal a company, account name, internal service, or customer identifier even after ordinary tokens are removed. It is suited to a private handoff only after review.

Custom private terms are literal values known to the user. Add names and project identifiers that automatic rules cannot reliably identify. A missing term, an unexpected encoding, or an unusual identifier can leave residual information in retained fields.

## Remaining risks

| Risk | Why it remains | User action |
| --- | --- | --- |
| Unrecognized private strings | Heuristics are incomplete, especially for names and business terminology. | Add private terms; inspect every retained field. |
| Preserved hostnames and routes | The optional setting retains endpoint structure. | Leave default aliases on for public reports; review private exports. |
| Behavioral reidentification | Request counts, methods, response codes, sizes, and timings reveal patterns. | Share only the requests and evidence necessary for the issue. |
| Original-file exposure | The private inspection view and original file still contain secrets. | Avoid screenshots or screen sharing of the original view; protect the source file. |
| Shell history and process lists | CLI `--term` values are arguments. | Prefer entering highly sensitive terms in the local browser UI; apply your normal shell privacy practices. |
| Local storage and downloads | Outputs may land in synced folders or inherit platform-specific protections. | Choose an appropriate directory and review its permissions. |
| Large or malformed files | JSON parsing is in memory. Validation limits source text to 50 MiB, entries to 50,000, and each URL to 32 KiB; CLI input is read before validation. | Use trusted, reasonably sized captures; these limits are not a general denial-of-service defense. |
| Modified or hostile runtime | Local processing cannot fix compromised software or devices. | Run code you trust in an environment you control. |

## CLI file safety

The CLI rejects writing over the input's canonical path or inode. It rejects output symlinks and requires a distinct file for each export. Existing outputs need explicit `--force`. New staged files use mode `0600` where supported, and each output is published atomically. No-overwrite publication uses an atomic link so another file appearing after preflight is not silently replaced.

These checks prevent common accidental replacement and alias mistakes. They are not a sandbox against an attacker who changes directory links or filesystem state concurrently. Multiple output files are independently atomic; a disk or permission failure during publication can leave some successful outputs. The original input is not deleted by the tool. Shell redirection is outside the CLI's file protections: never use `node bin/tracetidy.js input.har > input.har`, because the shell truncates the input before Node starts.

Errors omit raw exception messages, HAR snippets, original URLs, and file paths. Summary output uses aggregate counts. Audit output contains counts, not samples of removed secrets or a reversible mapping.

## Review checklist

- Use default endpoint aliases for a public report.
- Add private human names, organization labels, and identifiers as custom terms.
- Open the sanitized HAR and Markdown report; search for known private strings.
- Confirm that request/response bodies and credentials are absent.
- Consider whether timing, status, method, or size patterns reveal unnecessary context.
- Share the sanitized artifacts only. Keep the source HAR private.

If you discover a leak, remove any shared artifact you control and rotate exposed credentials when appropriate. Report the sanitizer defect with a minimal synthetic reproducer. Do not paste live secrets into the repository's issues.
