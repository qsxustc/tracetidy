# TraceTidy v0.2.0 launch copy

These are author-written drafts for manual posting. The GitHub repository is public, the code is MIT-licensed, and the online demo is available without login. The v0.2.0 Release provides source and static web archives, checksums and a release manifest. Public posts below link to the demo, source and Release. Check each community's current submission rules, disclose authorship, and adapt the post to its audience. No community posts have been sent by preparing this file.

- Public demo: [Try TraceTidy](https://tracetidy-lab-qsx.cherryboar4.chatgpt.site/)
- Public source: [qsxustc/tracetidy](https://github.com/qsxustc/tracetidy)
- Public Release: [TraceTidy v0.2.0](https://github.com/qsxustc/tracetidy/releases/tag/v0.2.0)

## 中文：即刻 / 朋友圈 / 开发者社区

做了一个开源小工具 TraceTidy，解决发 HAR 抓包前的整理和检查。在线演示免费，不用登录；抓包在浏览器本地处理。可以查看失败和慢请求、按接口聚合看 P95，再导出清理后的 HAR、Issue 草稿和清理记录。

默认移除正文和 Cookie，并为域名与路径生成别名。源码采用 MIT 许可证，也有零运行时依赖的 CLI。排障线索不等于根因，导出结果和手写说明仍需复核。欢迎试试内置合成样例，想听听：这些证据够不够让接收方继续排查？

演示：[TraceTidy](https://tracetidy-lab-qsx.cherryboar4.chatgpt.site/) · 源码：[GitHub](https://github.com/qsxustc/tracetidy) · 下载：[v0.2.0](https://github.com/qsxustc/tracetidy/releases/tag/v0.2.0)

## English: Show HN

**Title:** Show HN: TraceTidy – inspect HAR files locally and build a reviewed sharing pack

**Post:**

I built TraceTidy for the moment when a bug report needs a browser network capture, but sending the original HAR would expose more than the recipient needs. The free demo needs no account and processes captures locally in your browser. You can inspect requests, follow clickable observations about failures and slow phases, and group endpoints by method, host and path to see counts and P95 duration. These are observations from the capture, not root-cause diagnoses. The MIT-licensed source is available to inspect and run yourself, including a Node.js CLI with no runtime dependencies.

The export reconstructs allowed fields, removes bodies and cookies, and aliases hosts and paths by default. A ZIP contains the sanitized HAR, a Markdown issue draft and a removal audit. That deliberately loses diagnostic context; exports still need review, and reproduction notes you type are included as entered. I would appreciate feedback on whether you could investigate a bug from this pack, and what evidence you would miss. The demo includes a synthetic capture to try without using a real trace.

Demo: [TraceTidy](https://tracetidy-lab-qsx.cherryboar4.chatgpt.site/)

Source: [qsxustc/tracetidy](https://github.com/qsxustc/tracetidy)

Release: [v0.2.0 downloads and notes](https://github.com/qsxustc/tracetidy/releases/tag/v0.2.0)

## English: Reddit developer / side-project draft

**Title:** I built a local HAR workbench for preparing network-debugging handoffs

**Post:**

I'm the author of TraceTidy, an MIT-licensed app for inspecting HAR files and preparing a reviewed debugging handoff. The free demo needs no login and processes captures locally in your browser. It offers clickable observations for failed requests, slow phases and repeated endpoints, plus endpoint groups with P95 duration. Processing and ZIP preparation run in a Web Worker. The public source includes a Node.js CLI with no runtime dependencies.

The default export removes bodies and cookies, retains an allowlist of fields and headers, and aliases hosts and paths. You get a sanitized HAR, an issue draft and a removal audit together. This loses some diagnostic context, and the result still needs human review. Any reproduction notes you enter are included unchanged. I would like feedback on whether the remaining evidence is enough for a useful handoff, or which cases need a different policy.

The demo has synthetic data to try. If project links are allowed here: [demo](https://tracetidy-lab-qsx.cherryboar4.chatgpt.site/) · [source](https://github.com/qsxustc/tracetidy) · [v0.2.0 release](https://github.com/qsxustc/tracetidy/releases/tag/v0.2.0).

**Posting note:** Use this only in a community or dedicated thread that permits author project posts. Read its current rules and any self-promotion limits first; omit links or choose another venue if required. Do not repeat the same post across unrelated communities.

## Published Release and configured repository metadata

The repository and v0.2.0 Release are public. The Release includes the source archive, built static web archive, SHA-256 checksums and release manifest. Use the canonical tag URL below when sharing downloads and release notes.

- Public repository: [qsxustc/tracetidy](https://github.com/qsxustc/tracetidy)
- Published Release: [v0.2.0](https://github.com/qsxustc/tracetidy/releases/tag/v0.2.0)

### Configured GitHub repository metadata

**Description (under 160 characters):**

> Inspect HAR files locally, triage network issues, and export a reviewed sharing pack with sanitized HAR, issue draft, and audit.

**Topics:**

`har`, `network-debugging`, `developer-tools`, `privacy`, `sanitization`, `web-worker`, `javascript`, `command-line`, `local-first`

**Website:** `https://tracetidy-lab-qsx.cherryboar4.chatgpt.site/`

## 30-second demo script

Record only the built-in synthetic capture. Keep the pointer still between steps, and show the final export contents at a readable size. Use the current UI labels when recording.

| Time | Screen action | Chinese narration | English captions |
| --- | --- | --- | --- |
| 0–4 s | Open the demo and load the synthetic example. | 发浏览器抓包前，先看看里面有什么。 | Review a network capture before sharing it. |
| 4–10 s | Click a failure observation and open a matching request. | 本地查看失败请求和慢请求，线索直接跳到对应记录。 | Inspect failures and slow requests locally. |
| 10–15 s | Open endpoint groups; point to request count and P95. | 按接口聚合，快速看调用次数和 P95。 | Group endpoints; inspect counts and P95. |
| 15–21 s | Open the sharing preview and show aliases and removed fields. | 默认移除正文和 Cookie，用别名替换域名与路径。 | Default export removes bodies and cookies and aliases routes. |
| 21–27 s | Enter a short synthetic reproduction step, export the ZIP and show its three filenames. | 填写复现说明，导出 HAR、Issue 草稿和清理记录。 | Export a HAR, issue draft and audit together. |
| 27–30 s | Show the demo URL and the review notice. | 手写说明也需要自己检查，分享前请复核。 | Review the export and your notes before sharing. |

For a silent version, use the English captions and a final card with the demo URL. Do not display a real capture, credentials, personal browser tabs, notifications or account details.

## First-week execution plan

The dates below are relative to the verified public launch. They are a manual plan, not scheduled automations or instructions to send messages on the owner's behalf.

| Day | Action | Useful evidence |
| --- | --- | --- |
| 1 | Verify anonymous demo, source and Release access, check download checksums, review screenshots and links, and record the 30-second synthetic demo. | A fresh visitor completes example → review → ZIP export; downloaded archives match their published checksums. |
| 2 | If posting rules permit it, publish one author post linking to the demo, source and Release in the most relevant developer community. | Capture concrete questions and missing-context reports; do not treat views, likes or stars as proof of value. |
| 3 | Arrange two consented walkthroughs with developers or support engineers. Let them use synthetic data without coaching. | Note where import, triage, rule changes or export cause confusion. |
| 4 | Reproduce reported issues with synthetic fixtures, then fix the highest-impact confirmed problem. | A reproducible case and an appropriate verification result. |
| 5 | Offer a Show HN post if the project and demo are ready. Stay available to answer technical questions as the author. | Specific feedback on export policy, useful evidence and deployment. |
| 6 | Complete three more walkthroughs with relevant users; ask about their last real HAR handoff. | Workflow frequency, friction, what the recipient needs, and willingness to try it again. |
| 7 | Review the five walkthroughs and public feedback; choose one next improvement. | Proposed gate: 3 of 5 finish unaided and 2 agree to use it on their next relevant case. These are targets, not achieved outcomes. |

Avoid collecting original private captures for launch metrics. Ask feedback providers for a synthetic reproduction when filing a public issue. Repeated successful handoffs provide stronger evidence of utility than views, reactions or stars.

## Claims that are supported, with limits

- Verification for v0.2.0 passed all 58 automated tests: 52 core, processor, CLI and ZIP regressions plus 6 release-packaging tests. The static build also passed. Re-run verification when preparing a subsequent release or changing the deployed build.
- A 23.15 MiB / 10,000-request synthetic HAR workflow was checked in the Codex in-app browser on macOS. This is one workload and environment, not a claim about all browsers, unlimited file sizes or a measured acceleration percentage. See [performance notes](PERFORMANCE.md).
- HAR processing happens locally in browser memory; visitors still need to trust the JavaScript served by the demo origin. The public MIT-licensed source can be inspected and run locally; source availability alone does not establish that a deployed build matches it.
- The app's observations do not establish root causes. Default cleanup deliberately removes diagnostic context. Exported timing, status, sizes and patterns may still reveal information.
- Manually authored issue fields are included as entered and are not automatically sanitized. Review them and the final pack before sharing.

## Before any external post

- [ ] Test `https://tracetidy-lab-qsx.cherryboar4.chatgpt.site/` without a logged-in session, including the synthetic example and export.
- [ ] Confirm anonymous access to `https://github.com/qsxustc/tracetidy`; link to the public source and demo in promotional copy.
- [ ] Confirm anonymous access to `https://github.com/qsxustc/tracetidy/releases/tag/v0.2.0`, and verify that its four download assets and published checksums match.
- [ ] Re-run tests and build on the release commit, and check the hosted synthetic export.
- [ ] Confirm screenshots and the recorded demo contain synthetic data only.
- [ ] Read current rules for the selected community, keep the author disclosure, and post manually only where allowed.
- [ ] Do not claim complete anonymity, guaranteed safe sharing, superior security, broad compatibility, customer adoption, revenue or star counts without evidence.

The demo, repository and v0.2.0 Release are public. Verify the anonymous demo workflow and download links before distributing these drafts. Preparing this file does not mean any community posts have been sent.
