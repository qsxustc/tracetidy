# Changelog

## 0.3.0

- Added a baseline/current comparison tab with endpoint search, change filters, adjustable P95 thresholds and a jump to matching requests in the current trace.
- Matched exact method, origin and path while ignoring queries and fragments. Classified meaningful P95 changes using both absolute and relative thresholds (100 ms and 20% by default); any failure-rate increase takes regression priority.
- Added a synthetic baseline demonstrating regressions, improvements, added endpoints and removed endpoints alongside the existing current demo.
- Added anonymous `comparison.md` downloads and optional share-pack inclusion. Reports use independent `endpoint-N` IDs, complete recording summaries, and up to 100 endpoint rows by change priority; original route identities and alias mappings are omitted.
- Kept baselines in local Worker memory and discarded them when importing a new current recording, removing the baseline, clearing the session, or reloading the page. Stale comparison replies and ZIP downloads cannot restore old state.
- Bounded original request-header previews before assembling or escaping strings, with truncation notices for oversized values or header lists.

## 0.2.0

- Added explainable triage observations and clickable request filters for network failures, HTTP errors, slow phases and repeated endpoints.
- Added endpoint groups, P95, average and summed request duration, without splitting groups by query values.
- Added local issue title, reproduction steps, expected and actual behavior fields. Author text is included as entered and requires review.
- Moved HAR processing, report serialization and ZIP generation into a module Web Worker. Cached exports no longer repeat sanitization on each tab or download.
- Invalidated exports while a policy is changing, and discarded stale Worker/file results after session clearing or replacement.
- Preserved request and tab keyboard focus and added visible search focus.
- Unified missing-duration handling across original summaries, sanitized reports and diagnostics.
- Added a repeatable synthetic core benchmark and performance documentation.

## 0.1.0

- Initial local HAR inspector, strict allowlist sanitizer, alias-based exports, Markdown report, removal audit and zero-dependency CLI.
