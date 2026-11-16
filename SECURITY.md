# Security policy

Credspan is pre-release sandbox compatibility work. No production security claim is made. Interoperability evidence is limited to the documented modified walt.id Wallet API v2 1.2.1 peer and fixed synthetic profile. Verification sessions are one attempt: invalid cryptographic responses and ambiguous failures consume them permanently; request a fresh session. Only the latest default branch is maintained at this stage; no supported product release exists.

Report suspected vulnerabilities using GitHub's private vulnerability reporting on this repository when available. If it is unavailable, contact the maintainer through the contact route on [their GitHub profile](https://github.com/m1ngshum) to arrange private disclosure; do not post exploit details, keys, credentials, or personal data in a public issue. Do not assume a response-time guarantee.

Never use real credential subjects, production wallets, production issuer keys, or live secrets in tests. A sample environment file must contain comments or explicit placeholders only. Review [the threat model](docs/threat-model.md) before implementing services.

## Known limitations

The hosted profile is a private, single-owner, synthetic-data sandbox. Its trust boundary requires all-path Cloudflare Access, tunnel JWT validation, disabled direct provider ingress and the wallet Origin WAF rule in the [hosted runbook](docs/hosted-sandbox.md). Access alone does not correct the upstream wallet's permissive CORS behavior. Do not broaden users or data sensitivity without a new security and dependency review.

The 2026-11-13 scans of the qualified Linux amd64 sandbox images retained **2 HIGH API findings** and **12 HIGH wallet findings**, with no CRITICAL findings in those scans. The API findings identify legacy SD-JWT decoder versions with [tested source backports](docs/dependency-patches.md); raw scanner findings remain visible. The wallet findings are upstream dependency risk, not patched or proven unreachable. These dated image results are not a clean scan or a security claim for later builds; see [image evidence and limits](docs/image-risk.md).

Recorded sandbox acceptance includes a real hosted synthetic credential lifecycle, native TLS rejection checks, restart persistence and encrypted hosted-data recovery into an isolated clone. It does not establish production acceptance, destructive provider disaster recovery, or denial after a second real person's successful authentication. Hosted GitHub CI was blocked by account billing/spending restrictions during that acceptance; local validation does not replace the required CI merge gate.

Source publication requires separate authorization and review of Git history, GitHub discussions/PRs, Actions logs/artifacts, repository security settings and private operator material. The private artifact workflow is disabled in public repositories. Enable and verify GitHub private vulnerability reporting when publication makes it available; until then use the private contact route above. Publishing source does not authorize opening the hosted sandbox or publishing release artifacts.
