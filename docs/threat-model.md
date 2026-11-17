# Initial threat model

This is a design baseline, not evidence of implemented controls. The current runtime supports bounded local and private hosted synthetic membership sandboxes; this document separates implemented compatibility controls from future product controls. Revisit this model with every trust boundary introduced.

## Assets and boundaries

Protect issuer signing keys, wallet keys, subject identifiers and credentials, presentations, authorization grants, database backups, and operational secrets. Planned boundaries include untrusted API/browser/MCP clients → API; API → wallet service, Credo and PostgreSQL; verifier → credential issuer/status endpoints; CI → repository dependencies. Sandbox and production identities and keys must remain separate.

## Threats and required controls

| Threat | Implementation requirement | Acceptance evidence |
| --- | --- | --- |
| Unauthorized issuance or wallet access | Authenticate callers; authorize each tenant, wallet, key, and operation; deny by default | Cross-user/tenant rejection tests |
| Forged or replayed presentation | Verify proofs, intended audience/domain, fresh challenge, expiry and applicable status; consume challenge once | Invalid proof, wrong audience, stale/reused challenge tests |
| Untrusted issuer or algorithm | Explicit issuer/trust and algorithm policy; no trust inferred from successful cryptography | Unknown issuer/algorithm rejection tests |
| Key or subject data exposure | Secret injection, encrypted persistence where needed, redacted logs, minimal retention, no real subject fixtures | Log/fixture review and backup access/restore checks |
| SSRF through identifiers/status URLs | Restrict outbound destinations and redirects; enforce response/size/time limits | Loopback/private-address and redirect tests |
| Malicious dependencies or CI changes | Exact versions, reviewed lockfile, pinned action SHAs, least privilege, fork-safe CI | Frozen install and CI review |
| Unsafe MCP or deployment action | Explicit operation authorization and target; constrain sandbox tools; separately review production | Denial and authorization tests before release |
| Unavailable or inconsistent wallet/database | Bounded failures, transactional state, idempotent retries where required, tested recovery | Real integration fault and recovery tests |

## Compatibility slice controls and limits

The management API requires a configured administrator bearer key. Issuance accepts only bounded name/member ID attributes; profile, identifiers, expiry and issuer selection remain server controlled. Protocol metadata, token, credential and response endpoints remain protocol authenticated. Only final OID4VCI/OID4VP, a fixed DCQL `dc+sd-jwt` membership query, and the local issuer DID are configured. Remote DID resolvers are excluded: even an unverified holder identifier cannot initiate network DID resolution. Native Askar PostgreSQL records persist an immutable unique verification-attempt claim before cryptographic delegation. Duplicate or unavailable storage fails closed across processes; any resolved cryptographic attempt burns the session, including invalid input or a crash. Unknown sessions and malformed HTTP envelopes are rejected before creating claims. Claims contain only purpose and opaque record identifiers; retention is unresolved, so use disposable sandbox stores.

A local URL allowlist and explicit sandbox flag constrain startup; they do not isolate a network. Default bind and published database/wallet ports are loopback. Tests temporarily bind the API to all interfaces so the separate wallet container can reach it; use only an isolated test machine/network. Default wallet peer authentication is disabled for isolated tests, not a shared deployment configuration. Management keys must not enter browser bundles, persistent storage, URLs, logs or fixtures. The explicitly local console holds a manually entered key in memory only; raw credentials remain in the independent wallet and protocol runtime. The residual installed PEX decoder advisory is documented in [compatibility limits](compatibility.md); no general safe-dependency claim is made.

## Open decisions

Unresolved production work includes ecosystem trust/custody, tenant isolation, retention, RTO/RPO, public networking and seamless multi-cohort signing rotation. The implemented local profile, status policy, encrypted backups and disruptive recovery do not settle these production decisions. Production use is outside current readiness claims.

Issuer controls now include stable persisted identity references, explicit active-issuer route binding and separate immutable claims after grant-secret validation and bearer validation. Token and credential races are tested across independent processes. Failed post-claim attempts remain consumed; malformed pre-boundary requests do not burn valid offers. Cosmetic GET observation writes are suppressed so delayed reads cannot overwrite completed states. See [issuer semantics](issuance.md). The [verification/status policy](verification.md) now requires signed nonselective status, the exact local signer/URI, freshness, explicit local trust and holder binding. Native unique status allocations and immutable revocations prevent double allocation and lost competing updates. Receipt reads recheck original proofs and current status without extending authorization lifetime. Broader ecosystem trust, retention and production restore safety remain unqualified.

The local console uses same-origin generated SDK operations with redirect following disabled and a narrow CSP. Disconnect clears credentials/state and aborts/fences stale requests; separate request identities prevent older accepted refreshes or 401 responses from overwriting new state. Contract metadata is checked against actual API errors/responses; it is not itself runtime input enforcement. See [developer experience boundaries](developer-experience.md).

The [local operations boundary](operations.md) adds exact Host/Origin checks, a loopback Caddy edge with no API/PG host ports, nonowner runtime database rights, explicit native provisioning and schema checks, private secret volumes and redacted telemetry. Recovery authenticates the complete backup before database mutation, advances a generation outside the database, invalidates old runtime credentials and retires the entire restored managed cohort. This prevents stale claims and lost revocations from silently reactivating that cohort; it requires downtime and reissue. Store wrapping-key rekey is separately tested and does not rotate signing identity. These are local single-host controls, not production RTO/RPO, seamless rotation or public HTTPS acceptance.
