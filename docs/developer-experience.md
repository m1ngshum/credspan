# Console, contract and generated SDK

Use the pinned Node 26.13.1 / pnpm 12.18.0. The console serves a single-administrator synthetic sandbox, locally or in the private hosted profile. For hosted access, follow the [hosted runbook](hosted-sandbox.md); the local setup below remains available. The console does not add user accounts, tenant isolation, wallet custody or production readiness.

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm check
```

Prefer the [local Compose operations helper](operations.md) for explicit native provisioning and private runtime secrets. For a development fixture, start PostgreSQL/API as described in [the sandbox runbook](sandbox.md), then open `http://127.0.0.1:3000/console/`. The API serves the built console and `/openapi.json` from the same origin; no wildcard CORS or arbitrary server-origin input is enabled. Vite development is optional (set the API's `CONSOLE_DEV_ORIGIN=http://127.0.0.1:5173` explicitly): `pnpm --filter @credspan/console dev` binds loopback and proxies `/api` to the fixed loopback API on port 3000. Use the API-served build for the complete documented/browser-tested journey.

Enter the management key manually. It stays in memory and is checked on the first request; the console never embeds a key in a build variable, URL, cookie, browser storage or logs. Disconnect clears the client credential callback, aborts requests and clears session/capability/result state. Request identities fence late successes and errors across reconnects and overlapping result reads. Credentials are sent only to the same-origin management API with redirect following disabled. This reduces accidental exposure; it is not protection against malicious extensions or an XSS compromise. Use a trusted isolated machine.

Create a synthetic membership offer, copy its capability URL to your independent wallet, and check issuance status. Then create a memberId-only presentation request, give that exact URL to the wallet, and check the result. The console does not receive/present on the wallet's behalf or treat copying as completion. Offer/request URLs are short-lived capabilities: do not share them publicly. Revocation uses the stable issued credential ID and asks for confirmation; it is permanent and idempotent.

A green result says **Accepted at last check**, with the check time, original proof time and fixed authorization deadline. It is never continuously fresh status or a fresh sign-in. The display stops showing accepted attributes when either known authorization/credential deadline passes. Refresh clears stale success before requesting a new result. A generic **Not accepted** does not identify its cause; it can reflect pending, denied, expired, revoked or unavailable state. A successful local revoke operation can separately say revoked. Historical proof time never changes during a refresh. Persisted receipt timestamps must be valid and bound to the original stored request deadline or the API fails closed.

## Independent Docker wallet URLs

For a wallet container, `localhost` refers to the container itself. Configure the API's canonical `PUBLIC_URL=http://host.docker.internal:3000` and `HOST=0.0.0.0` on an isolated test machine, preserving the same URL/store identity across restarts. Add `--add-host host.docker.internal:host-gateway` when starting the wallet; configure its network fetch guard to trust that exact hostname. The browser opens `http://127.0.0.1:3000/console/` and talks to same-origin `/api`; it only copies the returned protocol URLs. The wallet dereferences their unchanged canonical hostname. No URL/audience/nonce rewriting is involved. Do not reuse an existing store provisioned under a different `PUBLIC_URL`.

The reproducible browser fixture below starts the pinned modified wallet and PostgreSQL with this configuration and proves the actual journey. Host-published wallet/database ports remain loopback. Binding the API to all interfaces is not network isolation: keep this setup off shared/untrusted networks. Unmodified walt.id 1.2.1 still requires the separately documented [parser compatibility patch](../vendor/waltid/README.md).

```sh
node vendor/waltid/build-peer.mjs
pnpm --filter @credspan/api exec playwright install chromium
pnpm test:browser
```

The interoperability journey uses actual Chromium, the API and independent wallet without mocked protocol responses. Separate reconnect race controls simulate only delayed old HTTP responses to prove they cannot replace or disconnect a new connection; those controls are not interoperability evidence. It checks real input bounds/errors against the management contract, selective wallet presentation, acceptance/revocation, immutable proof time, receipt corruption denial, desktop/narrow accessibility, keyboard navigation, empty browser storage/cookies and disconnect clearing. It also executes [the real SDK example](../examples/membership.mjs). `CREDSPAN_SCREENSHOTS=/private/tmp/credspan-console-review pnpm test:browser` optionally saves masked desktop/mobile screenshots outside the repository. Capabilities are masked, keys absent/cleared; traces/videos are not enabled. Firefox/Safari and physical mobile devices are not qualified by this Chromium run.

## Contract and SDK maintenance

`/openapi.json` describes the actual management controllers, stable operation IDs, bearer requirement, bounded inputs, HTTP 201 creation responses, distinct middleware 401 and Nest error bodies, and the pending/historical-denied/accepted result union. Manual runtime validators remain authoritative; Swagger decorators do not enforce validation. Name limits now consistently count Unicode code points, with ASCII controls and whitespace-only names rejected. Contract tests exercise real requests/responses, including 100/101 ASCII and astral-character boundaries and additional fields.

The offline exporter scans the same controller metadata without starting a listener, agent or database and writes `packages/sdk/openapi.json`. The actual runtime document is compared against it in the real browser fixture. Exact-pinned Hey API generates Fetch operations and types under `packages/sdk/src/generated`; the console and example consume those operations. Fetch is bundled with the generator; the deprecated standalone Fetch package is not installed. No hosted generation service is used.

```sh
pnpm generate
pnpm check:generated
```

Commit both contract and generated changes. `pnpm check` includes a byte-for-byte freshness comparison before/after regeneration; missing, changed or stale artifacts fail. Generation runs TypeScript builds so the generator's permissive exit behavior cannot silently admit missing SDK output. The generated code may include unused generic Fetch support templates; those are upstream generated artifacts, not claims of corresponding Credspan APIs.

## Example and diagnostics

With a running local API and modified wallet peer on loopback ports 3000 and 7006:

```sh
# MANAGEMENT_API_KEY is supplied in the environment, never a CLI argument.
pnpm run doctor
pnpm example
```

Use `pnpm run doctor` to select the project's diagnostic script; `pnpm doctor` runs pnpm's own health checks instead.

Optional `CREDSPAN_API_URL` and `CREDSPAN_WALLET_URL` select loopback origins for the example. It creates synthetic membership through the generated SDK, has the independent wallet receive/present exact returned URLs, checks the result, revokes and confirms denial with preserved proof time. It prints only a stable credential ID and sanitized assertions; failures do not dump raw requests, credentials or keys. The example still requires correct canonical API URLs for the wallet. `pnpm run doctor` reports pinned Node, Docker engine, reviewed peer patch label and the loopback API contract (port 3000 by default, or `CREDSPAN_API_URL`); it never reads/prints database or management secrets.

The CI definition adds the actual browser journey after the pinned peer build and retains the existing aggregate `ci` gate. Local results do not establish hosted CI acceptance; actual hosted checks remain required. New dependencies retain exact direct pins. A qualified child-only js-yaml security patch removes three initially introduced generator advisories; the fresh graph retains one high legacy PEX decoder finding. Codegen also accepts local JSON/internal references only. See [patch provenance](dependency-patches.md) and [dependency risks](compatibility.md). No blanket override, suppression or clean-audit claim is made.
