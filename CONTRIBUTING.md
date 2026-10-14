# Contributing to TraceTidy

Thank you for helping make network handoffs easier to review. Useful contributions include reproducible synthetic leak cases, accessibility fixes, browser compatibility improvements, and documentation corrections.

## Develop locally

Use Node.js 20 or newer. There are no runtime packages to install.

```sh
npm start
npm test
npm run build
```

The browser app and CLI share `src/har.js`. Sanitizer changes must behave consistently in both. Run the existing tests and build before proposing a change. Add a focused regression test when changing a redaction rule, field allowlist, validation, or file-safety behavior.

## Keep test data synthetic

Do not commit real HARs, live credentials, customer names, internal URLs, downloaded reports, or a mapping between real secrets and placeholders. Start from `samples/demo.har` or construct a minimal capture with fake values. If a defect requires a realistic structure, preserve the structure and replace all private contents.

Tests should verify that private values are absent from every export, not merely that the input was parsed. Exercise default route aliases as well as explicit route preservation. For CLI changes, cover stdout/stderr and preservation of the source file.

## Propose a change

1. Describe the user-visible problem and a synthetic reproducer.
2. Make the smallest useful change consistent with the local-processing design.
3. Explain what the change preserves or removes and why.
4. Include the test/build results and any remaining limitations.

Avoid adding network services, telemetry, dependencies, or persistent sensitive storage without discussing the concrete need and privacy boundaries first. Performance claims need a reproducible synthetic benchmark; security claims need a matching test and an honest description of limitations.

For a redaction defect, never publish a real secret as proof. Share a minimal synthetic case and expected behavior. If you exposed a credential elsewhere, follow your organization's rotation process; this repository cannot remove third-party copies.

Contributions are licensed under the repository's MIT license.
