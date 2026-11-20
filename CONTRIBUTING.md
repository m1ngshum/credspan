# Contributing

Use Node 26.13.1 and pnpm 12.18.0. Run `pnpm install --frozen-lockfile` and `pnpm check` before opening a pull request. Keep exact direct dependency versions and commit the lockfile when dependencies are introduced. Do not add unused product scaffolding or private source material. Real Docker-backed compatibility checks run with `pnpm test:integration` after building the modified wallet peer as described in `vendor/waltid/README.md`.

Describe the concrete change, validation performed, limitations, and base/head commit SHAs. Follow the [role workflow](AGENTS.md) and [sequential roadmap](ROADMAP.md). A review is valid only for its recorded base/head; any later change needs review again. Retargeting or rebasing invalidates reviews. Merge only after the `ci` check passes and the current revision has a recorded review. Repository administrators remain responsible for enforcement; workflow prose is not branch protection.

For behavior changes, include a small test that fails for the broken behavior. Do not commit credentials, wallet keys, personal credentials, production exports, real user data, operator email addresses or private provider identifiers. Use placeholders in documentation and keep actual values in private operator records. Review the staged diff and PR text for contextual private metadata; automated secret scanning alone does not detect it. Use generated fixtures and local or sandbox services. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Pull request review

Use Conventional Commit subjects and PR titles (`fix: ...`, `docs: ...`, or another appropriate type). Keep descriptions focused on the final change, actual validation and limitations; keep private task links in private tracking.

Codex code review complements the builder/reviewer workflow. Its repository-specific focus is in [AGENTS.md](AGENTS.md). Inspect the automatic review when a PR is ready. If no review arrives, or a later commit changes the reviewed code, request `@codex review` once for the current head rather than repeatedly triggering duplicate reviews. Verify the review's commit, not only its timestamp; a reaction or no comments is not evidence that required CI or procedural review passed.

Before handoff, check both inline threads and review summaries. Reproduce actionable findings, add a focused regression where appropriate, and fix them or record an evidence-backed reason they do not apply. Resolve conversations after the disposition is recorded. Do not weaken validation to satisfy a suggestion. After any source edit, obtain renewed affected Codex feedback, exact-base/head reviewer validation and required CI. Record their links and revision evidence in the private task; unavailable or stale review is an explicit gap, never a fabricated pass. Automatic review does not authorize merge or deployment.

This workflow uses the existing GitHub integration; it needs no API key, extra Actions job or automatic-fix bot. See [Codex repository review rules](https://developers.openai.com/blog/custom-code-review-rules-for-codex) (checked 2026-11-17).

## Source publication checklist

Publishing source exposes repository history and associated GitHub content. It does not publish a production credential service. Before changing visibility:

1. Review the exact final source and reachable Git history, issues/PRs/comments, Actions logs/artifacts and releases for secrets, private operator data and redistribution notices. Record the coverage and limits; a clean scanner result alone is not proof of absence.
2. Keep stacked PRs in dependency order. Obtain the required exact-head `ci` pass and recorded review before any merge. Local results do not waive branch protection.
3. Verify least-privilege Actions permissions, no pull-request secrets, immutable action pins and branch protection. Keep the private artifact workflow disabled for public repositories; any public release pipeline needs its own review.
4. Obtain explicit authorization for the visibility change. After that authorized change, enable and verify private vulnerability reporting and applicable secret-scanning/dependency alerts. Until verified, retain the fallback disclosure route in [SECURITY.md](SECURITY.md).
5. Keep the hosted API and wallet private under the [hosted sandbox boundary](docs/hosted-sandbox.md). Review any homepage links or status copy separately before publishing that static site; source visibility does not deploy the site or open sandbox access.

For a versioned source preview, use the [public source release process](docs/source-releases.md).
