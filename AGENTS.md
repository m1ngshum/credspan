# Credspan agent workflow

Keep changes small, source-backed, and within the current roadmap step. Do not copy private third-party code, invent test evidence, or describe planned capabilities as working. Read every caller before changing shared behavior; validate trust boundaries and preserve error handling.

## Delivery tracking

For Credspan delivery work, use the locally installed `$credspan-delivery` skill when available and reconcile the private planning issue/Project before handoff. Keep confidential task details outside public issues and PRs; a private Project does not make public repository items private. If the skill or tracking access is unavailable, follow this repository’s review/CI rules, record the tracking gap and continue authorized independent work. Tracking never grants merge, deployment, release or visibility authorization.

## Roles and handoff

- The builder implements the scoped change and supplies commands, outcomes, and exact base/head commit SHAs.
- The reviewer checks the proposed change and fixes findings in correctness, security, documentation, and real validation evidence.
- The coordinator merges only after CI passes and the reviewer’s verdict applies to the exact current head and base SHAs. Every postreview edit invalidates the verdict and requires review again.

These roles may share one GitHub identity. Record the review procedurally in the pull request with base/head SHAs; do not present it as an independent GitHub approving review. Never approve or merge one's own work by inference. Develop stacked, linked PRs in dependency order. When the user authorizes merging, the coordinator merges them sequentially after required hosted CI and exact-head review pass. Rebase each successor only after the coordinator supplies the preceding merged main SHA. Keep the repository private unless the user explicitly authorizes publication. Retargeting, rebasing, or any new edit invalidates the recorded review; revalidate and review the final base/head before merge.

## Code review focus

- Preserve authentication-before-mutation, maintenance fencing and immutable credential consumption/revocation. Failure must never reactivate a stale cohort or grant access.
- Check subprocess and stream cleanup on success, errors and cancellation; await retirement before releasing ownership or reporting completion.
- Trace credential-bearing requests to their exact configured origins. Reject redirects and keep secrets out of browser assets, logs and public records.

## Verification

Run `pnpm check` and any behavior-specific tests. Never use fabricated integration tests or coverage as production acceptance. A skipped external integration remains unverified. Actions must use verified full commit SHAs, least privilege, and no pull-request secrets. Production deployment and production MCP remain roadmap work.

## Privacy before committing

Treat this repository and every future commit as potentially public, even while visibility is private. Nonsecret does not mean publication-safe. Keep actual operator emails, tenant/project/site/zone/rule/deployment identifiers, private service URLs and credential operational metadata in private operator records; use explicit placeholders or reserved example domains here. Preserve required public upstream attribution.

Before every commit review the staged diff, and before posting review PR descriptions, comments and generated logs/artifacts for private metadata as well as secrets. Run the foundation checks; their bounded detectors do not replace contextual review. Never put a private-value denylist or raw secret evidence in source. Keep private planning and security findings out of public records. Redaction in a later commit does not erase history: source publication requires reachable-history and associated GitHub-content review.
