# Roadmap

The initial seven implementation slices are delivered for the bounded local/sandbox scope below. This repository starts from a reviewed source snapshot; its pull request numbers do not describe that earlier development history. This is not production acceptance or a claim that the later roadmap is complete. Each change used builder implementation and reviewer validation tied to exact base/head SHAs.

For future dependent changes, use stacked, linked PRs in dependency order. User-authorized merges proceed through the coordinator after required hosted CI and exact-base/head review pass; rebase each successor only onto the verified preceding merged main SHA. The source repository is public. Any further visibility change requires explicit user authorization. Any edit, retarget, or rebase invalidates the verdict and requires fresh validation/review before merge. Every step needs concrete acceptance evidence.

1. **Foundation:** Apache-2.0, scope and contribution docs, threat model, pinned pnpm workspace, foundation checks, CI, and dependency updates.
2. **Credential roundtrip:** real NestJS/Express API, Credo and PostgreSQL storage, walt.id Wallet API v2 integration; demonstrate issue → hold → present → verify using local/sandbox services and generated identities. Validate compatibility with installed packages and the actual wallet API contract.
3. **Issuer:** validated issuance flows, issuer key lifecycle, authorization, revocation/status behavior, and negative-path tests.
4. **Verifier:** presentation requests, challenge/domain binding, trust policy, expiry/status checks, replay rejection, and negative-path tests.
5. **UI and API SDK:** accessible issuer/holder/verifier flows and a typed SDK validated against the real API.
6. **Operations:** reproducible local deployment, migrations, backup/restore drills, observability, key/secret handling, and operational runbooks with measured checks.
7. **Local/sandbox MCP:** narrowly scoped tools, explicit authorization, secret boundaries, and end-to-end sandbox checks; no implicit production access.

## Later, separately scoped

Production MCP requires a separate security and operational review. The bounded loopback Compose helper belongs to step 6. A public/cloud deployment helper remains future work, with explicit target selection, previewable changes, credential isolation, rollback, and production acceptance criteria. Production MCP and public/cloud deployment are outside the initial seven slices. No production deployment is authorized by this roadmap alone.

Future milestones, separately scoped and unimplemented:

- International credential profiles/conformance and ecosystem-specific trust.
- Agent identity, explicit delegation and production MCP authorization.
- AWS ECS/Terraform and Kubernetes Helm deployment helpers, with explicit plans, credential isolation, recovery and acceptance evidence.

## How to qualify the next issuer and verifier workflow

Start with a decision a relying party needs to make, such as checking current membership eligibility. Record who issues the credential, which claims the verifier needs, how it identifies trusted issuers, and what it does when status is unavailable. A government or education profile may require different formats, trust anchors and status rules. Select its exact editions and participants before adding support.

- **Developer setup.** Time a clean checkout through issuance, wallet receipt, presentation, acceptance and refusal after revocation. Record prerequisites, downloads, assistance and cleanup so another developer can repeat the measurement.
- **Independent interoperability.** Pin the profile, configuration and released versions. Exercise Credspan issuance with an unmodified wallet, then present to both Credspan and a separately implemented verifier. Record each participant’s result and trust configuration. Keep the modified-wallet regression identifiable in the same record.
- **Adopter evidence.** Have an external team operate the selected workflow and record the setup effort, failures, recovery and reissue burden. Use its result to decide whether to extend Credspan, contribute a compatibility case upstream, or defer the profile.

A published compatibility claim should identify the exact passing combination and its limits. Official conformance or certification requires separate evidence for the applicable program and profile.
