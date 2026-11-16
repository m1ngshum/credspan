# Membership issuance API

This is a real authenticated issuer surface in the local sandbox. It remains a single configured administrator and active issuer, with the modified-wallet compatibility limits documented separately. The [console, OpenAPI and generated SDK](developer-experience.md) use these endpoints.

`POST /api/issuance-sessions` requires `Authorization: Bearer <management-key>` and exactly:

```json
{"name":"Synthetic Member","memberId":"member-42"}
```

`name` is trimmed, nonempty, at most 100 Unicode code points and contains no ASCII control characters. `memberId` is 1–64 ASCII letters/digits/dot/underscore/hyphen, starting with a letter or digit. Unknown fields, caller credential IDs, expiry, issuer selection and holder identities are rejected. Use synthetic data only in this release.

The response has `id`, the short-lived `offer` URI, a stable server-generated `credentialId` (`urn:uuid:…`), and ISO `expiresAt`. Name/member ID and those server values are persisted together before returning the offer. Redemption signs the exact identifier as `jti`, the exact server expiry as `exp`, and the validated membership attributes, bound to one ES256 holder key. Credentials last one hour from session creation; expiry is rechecked immediately before signing. One offer issues at most one credential. The preauthorized grant expires separately under Credo's short-lived offer policy.

`GET /api/issuance-sessions/{id}` requires the same bearer key. It returns only `id`, `state`, `credentialId`, `expiresAt`, `tokenConsumed` and `credentialAttempted`. It never returns member attributes, grant secrets, bearer tokens, keys or raw credentials. Unknown sessions and sessions outside the configured active issuer return 404; unavailable storage returns a sanitized 503 rather than pretending the session is missing. This is single-admin authorization, not a multitenant ownership model. Status reads remain usable after credential expiry. The managed cohort now has [signed status and authenticated revocation](verification.md).

## Atomic consumption and failures

The protocol accepts only final preauthorized issuance for `membership`, with one JWT proof. Authorization-code/refresh grants, PIN, client assertions/attestations, DPoP, batching, deferred response options and profile changes are unsupported. The guards use the same Express matchers as Credo, so case and trailing-slash aliases cannot bypass validation. Existing-but-inactive issuer records cannot redeem the active issuer's grant.

Two independent immutable native Askar inserts protect redemption:

1. A token claim is inserted after Credo validates the grant secret and any supported protocol checks, immediately before `AccessTokenRequested`. Wrong secrets and malformed/unsupported requests do not burn the offer. Claiming at this transition also prevents a stale losing token request from overwriting the winner's state.
2. A credential claim is inserted after the endpoint verifies the bearer signature/audience/subject and parses the allowed request shape, before proof verification/signing. Invalid token or malformed profile requests do not burn it. A structurally valid request with a bad cryptographic proof **does consume** the credential attempt.

Claims survive workers, process/database restart, exceptions and lost responses. A post-claim error is never rolled back: create a fresh issuance session. The transient losing-request WeakSet only prevents Credo's endpoint catch from writing stale `Error` over a winner's `Completed`; it is not the distributed security boundary. Durable native insertion provides that boundary. Offer/request GET observation transitions are deliberately not persisted, because delayed reads could otherwise overwrite completed sessions; the upstream allowed-state and expiry checks still run. Lifecycle state may remain `OfferCreated`/`RequestCreated` until an actual protocol attempt.

## Stable identity and provisioning

The dedicated store contains an immutable identity configuration with signer DID/key reference, issuer/verifier identifiers, profile version and public URL. Startup verifies referenced records and signing-key possession instead of picking the first record returned from an array. Adding unrelated keys/issuers does not change identity. Missing configuration/referenced keys, incompatible profile or changed public URL fails closed, without silently replacing keys or identifiers.

Initial database/schema provisioning remains a one-process operation. A unique native provisioning claim then protects identity creation; a crash leaves an incomplete claim that is not stolen automatically. PR2 stores without this configuration are not auto-migrated. Never delete records to force regeneration. [Local operations](operations.md) now provides explicit v1→v2 upgrade, disruptive cohort retirement/recovery and separate store rekey; these require downtime/reissue where documented. Quotas and production provisioning remain future work. Never restore old consumption records and reopen traffic without invalidating outstanding sessions.

## Verification

The Docker-backed suite exercises the actual authenticated APIs and independently implemented wallet; two separate API processes race the same token grant and credential request, and exactly one wins each stage. It checks identifier/expiry persistence, database/application restart, wrong-secret/no-burn requests, existing wrong issuer, malformed and route-alias rejection, post-claim failure semantics, missing identity/key startup rejection, and delayed real GETs that cannot regress completed state. No raw credentials or tokens are logged or committed.

Each new offer now reserves a permanent bounded status index and stable credential mapping before returning the offer. Signing includes a nonselective signed status-list reference; allocation failure or list exhaustion prevents offer delivery/signing. Authenticated revocation uses the stable credential ID; see [verification and status semantics](verification.md).
