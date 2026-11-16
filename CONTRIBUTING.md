# Contributing

Use Node 26.13.1 and pnpm 12.18.0. Run `pnpm install --frozen-lockfile` and `pnpm check` before opening a pull request. Keep exact direct dependency versions and commit the lockfile when dependencies are introduced. Do not add unused product scaffolding or private source material. Real Docker-backed compatibility checks run with `pnpm test:integration` after building the modified wallet peer as described in `vendor/waltid/README.md`.

Describe the concrete change, validation performed, limitations, and base/head commit SHAs. Follow the [role workflow](AGENTS.md) and [sequential roadmap](ROADMAP.md). A review is valid only for its recorded base/head; any later change needs review again. Retargeting or rebasing invalidates reviews. Merge only after the `ci` check passes and the current revision has a recorded review. Repository administrators remain responsible for enforcement; workflow prose is not branch protection.

For behavior changes, include a small test that fails for the broken behavior. Do not commit credentials, wallet keys, personal credentials, production exports, real user data, operator email addresses or private provider identifiers. Use placeholders in documentation and keep actual values in private operator records. Review the staged diff and PR text for contextual private metadata; automated secret scanning alone does not detect it. Use generated fixtures and local or sandbox services. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Source publication checklist

Publishing source exposes repository history and associated GitHub content. It does not publish a production credential service. Before changing visibility:

1. Review the exact final source and reachable Git history, issues/PRs/comments, Actions logs/artifacts and releases for secrets, private operator data and redistribution notices. Record the coverage and limits; a clean scanner result alone is not proof of absence.
2. Keep stacked PRs in dependency order. Obtain the required exact-head `ci` pass and recorded review before any merge. Local results do not waive branch protection.
3. Verify least-privilege Actions permissions, no pull-request secrets, immutable action pins and branch protection. Keep the private artifact workflow disabled for public repositories; any public release pipeline needs its own review.
4. Obtain explicit authorization for the visibility change. After that authorized change, enable and verify private vulnerability reporting and applicable secret-scanning/dependency alerts. Until verified, retain the fallback disclosure route in [SECURITY.md](SECURITY.md).
5. Keep the hosted API and wallet private under the [hosted sandbox boundary](docs/hosted-sandbox.md). Review any homepage links or status copy separately before publishing that static site; source visibility does not deploy the site or open sandbox access.
