# Running the local synthetic lane

Use the exact Node/pnpm versions from the root README and the [bounded local operations helper](operations.md). It generates independent synthetic management/store/database secrets, explicitly provisions native Askar once, then runs the API as a nonowner runtime role behind a loopback edge. Keep real subject data and keys out of this environment.

```sh
node vendor/waltid/build-peer.mjs
node ops/build.mjs
node ops/local.mjs init ./ops/local-state --apply
node ops/local.mjs provision ./ops/local-state --apply
node ops/local.mjs up ./ops/local-state --apply
```

To run the synthetic SDK walkthrough, [start the optional Compose wallet and run the example](developer-experience.md#from-the-local-compose-sandbox).

The canonical protocol URL and external generation are persisted boundaries. Do not pre-create an empty Askar database or silently regenerate a missing identity. Runtime opens only a provisioned store and requires private `CONTROL_DIRECTORY` state. Additional workers may open the same initialized store/key; parallel first provisioning is not supported. Upgrade/recovery is explicit and disruptive, as described in the operations runbook. The older root development Compose database fixture is not the restricted deployment profile.

`POST /api/roundtrips` with exactly `{}` and `Authorization: Bearer <management-key>` returns a synthetic credential offer, a fixed final OID4VP/DCQL request URI, and an opaque verification-session ID. `GET /api/roundtrips/{id}` requires the same management key and returns cryptographic state/version only. Treat returned offer/request URLs as short-lived capabilities. No caller-supplied subjects, query profiles, draft versions or credential formats are accepted. API creation is unbounded at this stage; expose it only locally and discard the sandbox store when finished.

Protocol `/issuer` and `/verifier` endpoints are public to the holder and authenticate through the credential protocol, rather than using the management key. The compatibility route uses synthetic membership claims; [the real issuance API](issuance.md) accepts bounded membership attributes with server-controlled ID/expiry, bound to one ES256 holder key. The verifier trusts only this store's local issuer DID and requests `memberId` without the name. Use the [authenticated presentation result API](verification.md) for current acceptance; the compatibility route's raw cryptographic state is not an acceptance decision. The complete external holder demonstration is automated:

```sh
node vendor/waltid/build-peer.mjs
pnpm test:integration
```

The test starts temporary PostgreSQL and the separately implemented, explicitly modified wallet peer, generates a real holder key, obtains/stores a real signed credential, and submits a real encrypted presentation. It asserts the actual API's resulting cryptographic state, not merely a wallet success response. Temporary runtime containers and directories are removed even on test failure; no raw credentials are printed or committed.

Verification sessions are **one attempt**. Once a stored session reaches the cryptographic boundary, an immutable native Askar insert claims it before verification. Concurrent duplicate submissions, later duplicates, storage failure and crashes fail closed. An invalid proof or failed/deferred outcome never releases the claim. Request a fresh session after any failure; retrying the same response is unsupported. Losing the response after successful verification is ambiguous: inspect authenticated cryptographic state, then start a fresh session if needed. This policy trades availability for simple durable replay protection and is not a complete product consent/acceptance policy.

The integration API must bind to `0.0.0.0` temporarily for container-to-host access (`host.docker.internal`). This flag and `CREDSPAN_SANDBOX=1` are not isolation controls. Host-published wallet/database ports remain `127.0.0.1`; run the suite on an isolated trusted machine/network and never expose this setup to the Internet. The local wallet fetch exception names only `host.docker.internal`; production network/trust policies remain unimplemented.

Stop the local deployment with `node ops/local.mjs down ./ops/local-state --apply`; data volumes remain. Destructive test cleanup applies only to exact disposable fixture resources.
