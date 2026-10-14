# TraceTidy: launch and revenue validation

## Product position

**A local, inspectable HAR handoff tool for people who need help debugging a network problem without attaching the entire private trace.**

The initial users are developers filing issues, support engineers asking for browser captures, and maintainers receiving them. The workflow is deliberately narrow: privately inspect the original HAR, apply strict export rules and optional private terms, then produce a sanitized HAR, an issue draft, and an aggregate audit from the same sanitized snapshot.

The product hypothesis is that this handoff is frequent and risky enough for a focused tool to earn repeat use. It has not been validated through customer interviews, paying customers, or repository popularity. Stars and revenue cannot be guaranteed.

## Existing tools and evidence of the problem

HAR viewing and sanitization are established workflows, with capable existing tools. TraceTidy should not be presented as an invention of the category or as a project without competitors.

| Existing option | What its primary source establishes | TraceTidy's proposed focus |
| --- | --- | --- |
| [Chrome DevTools Network reference](https://developer.chrome.com/docs/devtools/network/reference/#save-as-har) | Chrome already supports sanitized HAR export that excludes sensitive headers such as Cookie, Set-Cookie, and Authorization, and supports importing HARs for analysis. | A post-capture review workflow with strict field reconstruction, body removal, default endpoint aliases, and an issue handoff pack. |
| [Cloudflare HAR Sanitizer announcement](https://blog.cloudflare.com/introducing-har-sanitizer-secure-har-sharing/) | Cloudflare announced a free, open-source, client-side sanitizer in October 2023 after an incident involving session tokens stolen from a support system. The announcement discusses cookie/JWT removal and preserving useful authentication context. | A conservative public-share policy with no reversible alias map, plus a readable CLI and aggregate audit. This is a different tradeoff, not a claim of greater security. |
| [0xpanadol/har-viewer](https://github.com/0xpanadol/har-viewer) | Its repository describes an offline viewer with rich inspection, search/filtering, sanitized export, and large-file handling. | A narrower path from private original inspection to a strict sanitized snapshot and a three-file ZIP handoff. |

The Chrome export feature and Cloudflare's incident write-up support the existence of sensitive-HAR sharing risk; the viewer shows that local inspection and sanitized export already have alternatives. These sources do **not** establish unmet paid demand for TraceTidy. The next interviews must determine whether users prefer the specific strict-field-plus-alias workflow, whether it preserves enough diagnostic evidence, and whether team coordination creates a reason to pay.

Compare on a consented synthetic task rather than a feature-count claim: time to produce a reviewed report, detection of planted private values, context lost by each export policy, and the recipient's ability to investigate. Existing tools may be a better fit when richer payload inspection, large-file performance, or another export policy matters more.

## Interview five people before expanding scope

Recruit two developers who recently sent a HAR to support, two support engineers who receive HARs, and one open-source maintainer who handles browser-related bugs. Use recent examples; ask participants to demonstrate with synthetic data or their own approved test capture.

For each 20–30 minute interview:

1. Ask for the last time a HAR was requested or shared, including what triggered it.
2. Ask how they decided what was safe to send and what was removed manually.
3. Measure the steps, time, and back-and-forth required to get a usable report.
4. Let them try the demo without coaching. Observe import, private inspection, export, and review.
5. Ask which information the route aliases remove that they actually need to debug.
6. Ask what would make the tool usable in their existing support process and who could approve paying for it.

Record evidence rather than compliments: frequency of the workflow, an example of costly friction, time to a usable output, missing diagnostic context, adoption objections, and willingness to run another real-but-approved trial. Do not collect the participants' original sensitive traces in the project repository.

Proceed with the current scope if at least three of the five participants can complete the workflow unaided and at least two agree to use it on their next relevant case. Those are proposed validation gates, not achieved results.

## Release 0.1

Before a public release:

- Run the full test suite and static build on supported Node versions.
- Verify the demo uses synthetic endpoints, credentials, names, and payloads.
- Manually inspect each demo export in the default mode and in explicit route-preservation mode.
- Capture a short demo showing import → private inspection → alias-based safe preview → issue draft → export review.
- Keep the privacy boundaries visible in the README and UI; avoid an unconditional “safe to share” claim.
- Review the license, contribution instructions, and issue template.

Publish a repository with a descriptive tagline, the English/Chinese README, the synthetic sample, tests, and screenshots from that sample only. Use actual owner/repository links after the repository exists. Tag the first tested release `v0.1.0` and write release notes listing the features and limitations that are actually shipped.

Share the project where relevant HAR/debugging discussions already happen, following each community's promotion rules. Demonstrate the problem with a synthetic before/after example. Ask for leak cases and missing diagnostic evidence. Do not manufacture users, endorsements, stars, or benchmark claims.

## Publish the static demo on GitHub Pages

The app is static after `npm run build`; no HAR-processing server is needed. The build uses relative asset paths so a repository subpath can work. The deployment configuration below follows [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), with Node setup from the official [setup-node action](https://github.com/actions/setup-node).

After creating the GitHub repository:

1. Push the source and run the included CI.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. Add `.github/workflows/pages.yml` with the workflow below. Change the branch if your default branch is different.
4. Push to `main`, confirm deployment succeeds, and open the URL reported by the deployment.
5. Test the hosted app with `samples/demo.har`, including export and refresh. Add that verified URL to the README and repository description.

```yaml
name: Deploy Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          package-manager-cache: false
      - run: npm test
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
```

A hosted demo still asks users to trust the JavaScript served by that origin. Keep the local-run instructions equally easy to find. Do not add telemetry that collects HAR contents or private terms.

## Measure value before optimizing stars

Use a simple weekly ledger. These are proposed metrics; initial values are unknown until a public launch or user trial.

| Metric | How to measure without collecting captures | First validation target |
| --- | --- | --- |
| Unassisted first export | Observe consented demo sessions. | At least 3 of 5 interview participants. |
| Time to usable issue draft | Time the same synthetic task in observed sessions. | Median under 3 minutes. |
| Repeat use | Ask trial users whether they used it on another approved case. | 3 repeat users within 30 days of launch. |
| Lost diagnostic context | Ask whether the recipient could investigate the sanitized evidence. | At least 3 successful handoffs; list failures. |
| Redaction defects | Count reproducible synthetic leak reports and test coverage. | Fix confirmed high-impact leaks before promotion. |
| Paid demand | Record an approved team trial, a named budget owner, or a signed purchase commitment. | 2 qualified teams before building paid infrastructure. |
| Repository interest | Record real stars, issues, forks, and useful contributions. | Track trend; no promised star count. |

Avoid collecting identifiable traces simply to measure engagement. Downloads or stars show interest; repeat successful handoffs show product value. Revisit the product if route aliases consistently prevent investigation or people do not repeat the workflow.

## Paid roadmap: hypotheses, not shipped features

Keep the local app and CLI useful and auditable under MIT. Potential paid value should solve team coordination beyond the current single-user workflow:

| Candidate offering | Possible customer benefit | Validation required |
| --- | --- | --- |
| Organization policy packs | Shared rules, required private terms, and reviewed field policies. | Teams show inconsistent manual review and request managed policy. |
| Support workflow integrations | Sanitized attachments and issue drafts fit an existing ticket flow. | Support staff demonstrate enough volume and approve integration access. |
| Policy review and onboarding | A documented rollout with training and synthetic acceptance tests. | A budget owner agrees to pay for this service. |
| Team governance | Policy versioning, approvals, and aggregate audit evidence. | A concrete organizational requirement and a privacy-reviewed design. |
| Self-hosted managed distribution | Controlled updates and deployment assistance. | A team requests it and accepts a paid pilot. |

None of these exists in the current release. Do not build accounts, billing, remote trace storage, or broad AI features until interviews and a paid pilot justify them. If remote processing is ever proposed, it needs a separate threat model and explicit user consent.

For the first paid trial, sell a bounded service or pilot with a clear deliverable and review date. Determine pricing through actual buyer conversations; do not invent an existing monthly revenue figure. A first signed trial is a better milestone than a speculative revenue forecast.
