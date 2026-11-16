# Private hosted sandbox

This profile is a private, single-owner, synthetic-only sandbox. The hosted implementation is included in source; its operator-managed deployment is separate from the public homepage. Source publication does not open either hosted application. The existing local Compose/MCP profile remains separate. No additional wallet UI is built.

## Fixed boundary

- API and existing console: `https://credspan-sandbox.m1ngshum.com` (`/console/`). Wallet API: `https://credspan-wallet.m1ngshum.com`.
- Cloudflare Access must protect **every path** on both names. Human allow policy: the exact single operator email retained in the private deployment record; no email-domain or everyone rule. Separate service-auth policies permit a wallet token only on the API application and a helper token on both applications. No bypass policy. The tunnel must require the corresponding application audience and team JWT, use canonical HTTP Host overrides, then catch-all 404. Never create public Railway domains.
- The API permits only its exact canonical host and same origin. `healthcheck.railway.app` is permitted solely for `GET /health/ready`, without an Origin header or query. It does not authorize management routes. The existing bearer management key remains required behind Access.
- Access service credentials stay in wallet service variables and private helper files. The modified wallet adds them only to the exact API HTTPS origin, including effective port 443, never to a different origin or redirects. Hosted HTTP header logging is disabled. Browser JavaScript receives no Access service credentials.
- The API's existing status resolver remains in-process: only its exact configured status URI is accepted, and the fresh signed token is read from durable state. It sends no network request and needs no Access service credential.

### Mandatory wallet Origin WAF rule

The upstream wallet has permissive CORS. Keep an enabled Cloudflare custom WAF rule with action **Block** and this exact expression:

```text
(http.host eq "credspan-wallet.m1ngshum.com" and any(http.request.headers["origin"][*] ne "https://credspan-wallet.m1ngshum.com"))
```

An absent Origin is permitted for service calls; only the exact canonical wallet Origin is permitted when present. Null, sibling, hostile, lookalike and conflicting multiple Origins must receive 403. An authenticated exact-origin and no-Origin control must still succeed. The rule affects only the wallet hostname and does not replace Access, tunnel audience checks or disabled direct ingress.

Retain the rule/zone/entrypoint identifiers, Access application audiences and scoped service-token recovery information in the private deployment record outside this repository. Before starting the tunnel after setup, restart or recovery, verify this rule, all-path Access and tunnel audience checks are enabled. Start the protected tunnel only for acceptance, then repeat these positive/negative checks through the real edge before resuming normal service. **Restoring only Access and the tunnel is insufficient** and reintroduces the wallet cross-origin boundary failure. Stop the tunnel if any check fails.

## Native PostgreSQL gate

Use a separate **Supabase Free, Singapore** project. Pausing is accepted. Use the **session** pooler on port **5432**, never the transaction pooler on 6543. The deployment is Linux **amd64** only. The pinned native v0.5.0 Linux arm64 artifact rejected trusted RSA chains with `BadSignature`; it is not qualified for this profile.

Set native SQLx variables `PGSSLMODE=verify-full` and `PGSSLROOTCERT=/data/supabase-ca.crt`. Do not add `sslmode`/`sslrootcert` URI query options: pinned Askar v0.5.0 `Options::into_uri` omits the separator between remaining query parameters. TLS variables avoid this upstream defect without a proxy or verification downgrade. Credo's timeout/connection-count parameters are consumed before native URI reconstruction.

The qualified profile uses database/store ID `postgres`, the project's Singapore session pooler on port 5432, and an isolated private schema named exactly like the owner's pooler username: `"credspan_owner.<project-ref>"`. Resolve the project reference and pooler host from the private deployment record; angle-bracket placeholders must never be executed literally. Initial native provisioning defaults the schema to the connection username. Both owner and runtime PostgreSQL roles must have their search_path set to that quoted schema. Do not set native `schema=`: its provision-existence query uses an incompatible placeholder in this pinned release.

Precreate the schema as the owner role. Native initial `CREATE SCHEMA IF NOT EXISTS` still checks database CREATE privilege. If needed, the operator grants CREATE on this database only for the single `Store.provision(recreate:false, profile:"postgres")` invocation and revokes it in a finally block, then verifies the privilege is false. Never give runtime CREATE or use `recreate:true`. The store key must already be retained privately and reused for all qualification, identity provisioning and restarts.

Steady-state roles are NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOBYPASSRLS. Runtime gets schema USAGE, SELECT on native config/profiles, SELECT/INSERT/UPDATE/DELETE on items/items_tags, and USAGE/SELECT on the three native sequences. It gets no DDL rights. Keep this schema outside Data API exposed schemas and give anon/authenticated no privileges. Native storage encryption and SQL role grants are the boundary; this profile does not add speculative RLS policies.

Required evidence before deployment: native trusted-CA and correct-host success; wrong-CA and wrong-host rejection in fresh processes; server-confirmed TLS; provision/open/reopen with the least-privilege roles; tagged CRUD, duplicate rejection and exact synthetic cleanup. `apps/api/tests/tls.test.ts` supplies a disposable TLS PostgreSQL fixture. Set `TLS_API_IMAGE` to the exact reviewed amd64 API image ID and run its compiled test. `ops/hosted/qualify-postgres.mjs` supplies the runtime actual-target probe inside that image; its environment comes from a private `--env-file`, not shell arguments. `QUALIFY_EXPECT_TLS_REJECTION=1` requires a certificate-specific native failure.

## Source builds and services

API: configure the provider directly with Dockerfile `ops/hosted/Dockerfile`, start command `node /app/ops/hosted-bootstrap.mjs`, readiness path `/health/ready`, timeout120seconds, one replica and bounded on-failure retries. Railway config-as-code JSON/TOML is deprecated in the current provider API. The build fetches official native artifacts and verifies the committed hashes; no ignored local cache is required. It pins amd64, Node, pnpm, base/runtime images and existing dependencies.

Pin the source deployment to the reviewed commit and set the API service build variable `SOURCE_REVISION` to that full commit SHA before building. Confirm the resulting image's `org.opencontainers.image.revision`; the Dockerfile's `unqualified` default is not acceptance evidence. Record the wallet's source deployment commit separately from its label, which identifies the pinned upstream wallet revision.

Wallet: configure Dockerfile `ops/hosted/Wallet.Dockerfile`, image entrypoint unchanged, health path `/livez`, timeout180seconds and one replica directly in the provider. The build fetches the exact public upstream revision, checks all three patch hashes, runs the preauthorized metadata tests and the new shared Access client boundary tests, then replaces the digest-pinned base image’s visible service payload with the complete reviewed `installDist` runtime and classpath. Inherited OCI layers still retain the original base bytes. The complete shared-library suite is additionally run locally with its existing org1.localhost loopback DNS fixture; that host mapping is not part of the deployed image. Wallet source remains modified interoperability peer software, not a certification claim.

API variables: `CREDSPAN_SANDBOX=1`, `CREDSPAN_HOSTED_SANDBOX=1`, `PUBLIC_URL=https://credspan-sandbox.m1ngshum.com`, `HOST=::` (dual-stack), `PORT=3000`, `CONTROL_DIRECTORY=/data/control`, `ASKAR_STORE_ID=postgres`, stable `ASKAR_STORE_KEY`, `MANAGEMENT_API_KEY`, runtime `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and the two PGSSL variables above. No owner password is retained in the serving service. `POSTGRES_CA_PEM` and `CONTROL_GENERATION` are used only by operator volume initialization.

Wallet variables: `CREDSPAN_ACCESS_ORIGIN=https://credspan-sandbox.m1ngshum.com`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. Its listener is port **7006** and its health path is `/livez`. Mount its persistent volume at `/waltid-wallet-api2/data`; SQLite is `data/wallet2.db`. Its root bootstrap only repairs volume ownership, then drops to UID/GID 10001.

Mount the API volume at `/data`. Its root bootstrap sets the volume root to root:65532 mode0750, writes the supplied CA root:65532 mode0640, and creates the generation control root:65532 mode0640 within a root-owned mode0750 directory. App UID65532 cannot modify or replace either file. Normal startup drops groups/UID before importing the application. It requires existing active control and opens the existing native store; it never generates new store keys, provisions a store or initializes identity.

Bootstrap sequence (operator only, no public ingress until accepted):

1. Retain stable keys and choose one UUID generation. Locally create a matching fenced control plus exclusive provision maintenance lock; run the reviewed amd64 maintenance command as UID/GID65532 with owner credentials and that same store key. Existing native tables are opened with `recreate:false`; identity initializes only in this explicit maintenance operation. Confirm durable identity/generation before activation.
2. Run the deployed root bootstrap once with argument `init`, supplying the CA PEM and matching `CONTROL_GENERATION`. It uses exclusive creates and refuses to overwrite existing controls/CA. It does not touch the database or keys.
3. Run it once with argument `activate`; it requires the existing fenced control and matching operator-selected generation, then atomically activates that generation. Restore the normal start command. Startup still verifies durable identity matches, so a wrong generation stays unavailable.
4. Verify readiness over private networking and the immutable control boundary, then enable only Access-protected tunnel DNS. Check unauthenticated rejection on every application and valid service access on its intended application only.

Tunnel image: `cloudflare/cloudflared:2026.11.0@sha256:bf723075c9a1a35e785bdcac0e8420f504e8074cc65784ed03300b8219aafadc`; start `cloudflared tunnel --no-autoupdate run` with a private tunnel token. Ingress goes to `http://api.railway.internal:3000` and `http://wallet.railway.internal:7006`. Keep one replica per service in Singapore. The public TLS/Access edge and tunnel JWT validation are required; the internal plain HTTP endpoints must never acquire public Railway domains.

## Synthetic acceptance and operating cost

The helper uses the existing full issue/hold/present/verify/revoke flow:

```sh
CREDSPAN_HOSTED_SANDBOX=1 \
MANAGEMENT_API_KEY_FILE=/absolute/private/management-api-key \
CF_ACCESS_CLIENT_ID_FILE=/absolute/private/helper-client-id \
CF_ACCESS_CLIENT_SECRET_FILE=/absolute/private/helper-client-secret \
pnpm example
```

It reports acceptance before revocation, rejection after revocation and preserved historical proof. It fails on redirects and confines all requests to the two exact configured origins. Private files must be owned by the invoking user, mode0600, non-symlinks and bounded. `node --test examples/connection.test.mjs` verifies that boundary. Run `pnpm check` and the full integration suite with the modified shared HTTP jar as well; a passing local fixture does not replace this actual hosted roundtrip.

Railway Hobby: retain the user-approved $20 alert and $30 hard compute stop. Supabase stays Free; no paid upgrade is implicit. Tunnel connections and native database pools keep outbound traffic active, so automatic Railway sleep cannot be relied on. Use explicit manual stop/start of API, wallet and tunnel for on-demand operation; preserve volumes and database. Billing hard stops and Supabase pauses can interrupt readiness. Do not weaken Access or publish a direct origin to wake services.

## Backup and recovery

Free Supabase is not a backup service. Export the isolated native schema with a consistent pg_dump, encrypt it with the existing authenticated backup mechanism, and retain separately the stable store key, database credentials, external generation/control, management key, official CA, Access/tunnel and wallet Origin WAF recovery configuration and exact image/revision evidence. Stop/fence the API first; stop the wallet before copying its SQLite database (or use SQLite's supported online backup), retaining any WAL/SHM state consistently. Never copy a live SQLite file alone.

For recovery, keep ingress disabled, fence the operator control and disable runtime login. Restore only the intended private schema with verified authenticated backup and retained store key; preserve the encrypted old database/archive for investigation. Follow the existing `docs/operations.md` managed-cohort retirement procedure under owner maintenance credentials, advancing external generation and creating a new signer/issuer/verifier/status cohort before activation. Reissue synthetic credentials. Never reactivate an old generation or serve an old backup's revocation state: a stale archive can have lost newer revocations. Native store rekey alone does not retire the old credential cohort. Reopen runtime only after verifying readiness, new cohort, old credential rejection and the full revoke roundtrip. Keep maintenance credentials outside serving services.

### Hosted operator fence and retirement

`ops/local.mjs` deliberately accepts only local deployments. Do not point that CLI at Supabase or loosen its guards. Railway's normal bootstrap has only `init` and `activate`; `init` must never be reused for recovery. With the tunnel and API stopped, retain the old external generation separately, generate and retain a **new** UUID, and set the API service's `PREVIOUS_GENERATION` to the old external value and `CONTROL_GENERATION` to the new value. Run the following one-off Railway start command against its existing `/data` volume, with restart retries disabled for this operator deployment:

```sh
node --input-type=module -e '
import assert from "node:assert/strict";
import { writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { readControl } from "/app/apps/api/dist/src/control.js";
assert.equal(process.getuid(), 0);
process.setgroups([]); process.setgid(65532);
const control = readControl("/data/control", true);
const generation = process.env.CONTROL_GENERATION;
assert.match(generation ?? "", /^[a-f0-9-]{36}$/);
assert.equal(control.generation, process.env.PREVIOUS_GENERATION);
assert.notEqual(generation, control.generation);
const path = "/data/control/generation.json", next = path + ".next";
const fd = openSync(next, "wx", 0o640);
try { writeFileSync(fd, JSON.stringify({ generation, state: "fenced" })); fsyncSync(fd); } finally { closeSync(fd); }
renameSync(next, path);
const directory = openSync("/data/control", "r");
try { fsyncSync(directory); } finally { closeSync(directory); }
console.log("New external generation fenced; no database changes made.");
'
```

A successful one-off exit is not an API deployment. Confirm its fixed success message and leave the API stopped. Repeating it must fail the old-generation check, leaving the new fence unchanged. Never delete an unexpected `.next` file automatically; inspect a failed operation while ingress remains disabled.

Using the separate administrator connection, execute `ALTER ROLE credspan_runtime NOLOGIN;` and `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'credspan_runtime' AND pid <> pg_backend_pid();`. Confirm there are no remaining runtime sessions; stop if either operation is unavailable. Export with the owner connection using `pg_dump --format=custom --no-owner --no-acl --schema='"credspan_owner.<project-ref>"'`. Supply connection secrets through a private environment file or `PGPASSFILE`, and retain `PGSSLMODE=verify-full` and the official CA. Pipe that child process through `encryptProcessBackup` in `ops/backup.mjs`; do not redirect a plaintext dump into the backup directory. Restore only inside `withVerifiedBackup`'s callback, using `pg_restore --exit-on-error --no-owner --no-acl`; this authenticates the complete archive before any database mutation. The destination must be an empty quarantined target with the schema/role/search-path mapping explicitly prepared, never a blind overwrite of the serving schema. Preserve the old target and its encrypted backup. A new Supabase project or other paid resource needs its own authorization.

For the existing `retire --apply` command, prepare a private operator environment file for the reviewed amd64 image: the hosted configuration above, **owner** database credentials for the quarantined target, the retained store key, `CONTROL_GENERATION` equal to the newly fenced external generation, and `PREVIOUS_GENERATION` equal to the identity generation **inside the authenticated backup** (which may differ from the old live generation). Mount the official CA read-only at `/operator-ca.crt`; set `PGSSLROOTCERT=/operator-ca.crt` and `CONTROL_DIRECTORY=/operator-control`. Run the image with `--user 0:0`, that private `--env-file`, no published ports, and this Node command:

```sh
node --input-type=module -e '
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chownSync } from "node:fs";
import { randomUUID } from "node:crypto";
assert.equal(process.getuid(), 0);
assert.equal(process.env.CONTROL_DIRECTORY, "/operator-control");
assert.match(process.env.CONTROL_GENERATION ?? "", /^[a-f0-9-]{36}$/);
assert.ok(process.env.PREVIOUS_GENERATION && process.env.PREVIOUS_GENERATION !== process.env.CONTROL_GENERATION);
process.setgroups([]); process.setgid(65532);
mkdirSync("/operator-control", { mode: 0o750 });
process.env.MAINTENANCE_OPERATION_ID = randomUUID();
writeFileSync("/operator-control/generation.json", JSON.stringify({ generation: process.env.CONTROL_GENERATION, state: "fenced" }), { flag: "wx", mode: 0o640 });
writeFileSync("/operator-control/maintenance.lock", JSON.stringify({ operationId: process.env.MAINTENANCE_OPERATION_ID, operation: "retire" }), { flag: "wx", mode: 0o640 });
chownSync("/operator-control", 0, 65532);
process.setuid(65532);
process.argv = ["node", "maintenance", "retire", "--apply"];
await import("/app/apps/api/dist/src/maintenance.js");
'
```

Keep this maintenance container on failure for investigation, with its private environment inaccessible to the serving app; do not retry a partial retirement with a fresh lock. After successful retirement, apply and verify least-privilege grants on the recovered target, update only the serving runtime connection, and enable runtime login. Run the existing bootstrap `activate` once with the new `CONTROL_GENERATION`, restore the normal start command/restart policy, and verify readiness with ingress still disabled. Reject every old offer/token/request/credential cohort, complete a new issue/hold/present/verify/revoke flow, and prove an ordinary restart preserves the new identity. Revalidate the mandatory edge boundary above before resuming normal tunnel service. A local recovery test does not establish acceptance of a newly restored hosted target; record that target's gate as pending until actually exercised.

## Recorded acceptance and remaining gates

The 2026-11-13 private acceptance record covers the actual hosted synthetic issue/hold/present/verify/revoke flow, the human browser console, native PostgreSQL TLS negatives, restart persistence, and an encrypted hosted-data restore into an isolated clone with old-cohort rejection. It does not claim destructive provider failover or a second real person's authenticated denial test. The exact source/image hashes and operator identifiers remain in the private deployment record. The repository's procedures still require revalidation for each new deployment or recovery; prior acceptance is not a blanket pass. See [SECURITY.md](../SECURITY.md) for residual image findings and the blocked hosted CI gate.
