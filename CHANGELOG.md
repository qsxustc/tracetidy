# Changelog

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
