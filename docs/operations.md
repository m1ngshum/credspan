# Local operations qualification

This deployment is an isolated synthetic sandbox on one Docker host. It serves loopback HTTP through Caddy; it does not qualify public domains, TLS, cloud deployment, high availability or production use. Only the edge port is published on loopback. API and PostgreSQL have no host ports. The optional independent wallet publishes its own loopback API port. Do not put real subject data in it.

## Build, check and explicitly apply

Use the pinned Node/pnpm toolchain, the digest-pinned glibc distroless runtime (with the separate Node builder), a local Unix Docker endpoint and the [reviewed modified wallet peer](../vendor/waltid/README.md). Remote SSH/TCP Docker contexts are rejected. The helper pins the effective local endpoint rather than following later context changes. Successful hosted GitHub Actions checks remain a merge gate. Main branch protection requires the strict `ci` check, resolved conversations and linear history, including administrators. The source repository is public; private operator records and hosted access remain restricted. Coordinator merges require user authorization, required CI and exact-base/head review.

```sh
pnpm install --frozen-lockfile
node vendor/waltid/build-peer.mjs
node ops/build.mjs
node ops/local.mjs init ./ops/local-state
node ops/local.mjs init ./ops/local-state --apply
node ops/local.mjs check ./ops/local-state
node ops/local.mjs render ./ops/local-state
node ops/local.mjs provision ./ops/local-state --apply
node ops/local.mjs up ./ops/local-state --apply
```

`build.mjs` requires clean committed source and records its exact revision on the image. `--interim` explicitly permits dirty-tree experiments; those images are not release evidence. Init resolves the development image and modified peer tags to immutable local image IDs. PostgreSQL, Node and Caddy use pinned upstream digests. No image is pushed. Init creates a private state directory, random synthetic secrets and an external control directory. Existing Compose resources or private volumes with a different deployment ownership marker are rejected. Keep `project.json`; names alone do not establish ownership.

Commands default to a nonmutating plan; only `--apply` changes state. `check`/`render` inspect an existing project. Open `http://127.0.0.1:8080/console/` and enter the private management key from the state directory. Keep capabilities and secrets out of shell history, screenshots and logs. Canonical protocol URLs use `http://host.docker.internal:8080`; the Compose edge owns that exact network DNS alias. The independent wallet dereferences the unchanged URL. Browser access uses loopback, with exact allowed Host/Origin checks; arbitrary names/origins are denied. Missing Origin remains valid for wallet clients.

## Native provisioning, permissions and upgrades

Only the explicit one-shot provisioning command invokes native Askar `provisionStore`. It writes Credo's storage version and the stable signer/configuration. Runtime explicitly opens the existing store, disables automatic migration and refuses missing, unsupported or mismatched identity/generation records. Readiness checks the persisted schema, generation and cohort with a bounded wait; liveness alone does not imply readiness.

The runtime PostgreSQL role is nonowner, NOINHERIT, NOSUPERUSER, NOCREATEDB and NOCREATEROLE. It has CONNECT, schema USAGE, SELECT on native configuration/profile tables, DML on native items/tags and the necessary sequence rights. It has no owner password, schema CREATE or configuration UPDATE privilege. The maintenance owner can provision the dedicated store; the cluster administrator is confined to operator database commands. These roles are scoped to this isolated cluster, not a shared production-cluster recipe.

The API/maintenance containers run under the invoking nonroot UID/GID, read-only filesystems and dropped capabilities. A network-disabled root initializer only writes/chowns private named volumes to that UID; it never runs the API. Host input secrets are validated private regular files and passed over bounded stdin. This avoids Docker Desktop file-bind ownership and atomic-rename visibility differences observed during qualification. Worker mounts contain private 0700 directories and 0600 files. Runtime receives no owner/admin secret. The control **directory**, rather than one file inode, is mounted read-only so atomic generation replacement is observable.

Schema version 2 introduces the external generation and managed cohort namespace. For an existing version-1 store, prepare the same store key/canonical URL and a fenced control directory, then explicitly run `upgrade ... --apply` through this helper. Upgrade supports only v1→v2, retires the old managed cohort and requires reissue. Unknown versions fail closed; there is no generic automatic migration. `maintenance check` reports the actual installed Credo storage version. Back up and retain separate rollback secrets before any upgrade.

## Backup and disruptive recovery

Run this from the repository root with the original project still present. The new target directory/name must not already exist; keep the original state, control directory and protected backup key. The example intentionally reuses the canonical port only after fencing/stopping the source.

```sh
# Record the generation belonging to this archive before advancing the fence.
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { load, backup, withLock } from './ops/local.mjs';
const source = await load('./ops/local-state');
await withLock(source, 'backup', async () => {
  const { generation } = JSON.parse(await readFile(source.controlDirectory + '/generation.json'));
  await writeFile('/private/tmp/credspan-backup.generation', generation, { flag: 'wx', mode: 0o600 });
  await backup(source, '/private/tmp/credspan-backup.enc');
});
JS
node ops/local.mjs fence ./ops/local-state --apply

# Explicit preparation/apply using the same tested helper as the CLI.
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load, init, recover } from './ops/local.mjs';
const source = await load('./ops/local-state');
const target = await init('/private/tmp/credspan-recovered-state', {
  name: 'credspan-recovered', port: source.port, image: source.image,
  controlDirectory: source.controlDirectory,
});
await writeFile(join(target.directory, 'secrets/store_key'),
  await readFile(join(source.directory, 'secrets/store_key')), { mode: 0o600 });
const generation = (await readFile('/private/tmp/credspan-backup.generation', 'utf8')).trim();
await recover(target, '/private/tmp/credspan-backup.enc',
  join(source.directory, 'secrets/backup_key'), generation);
JS
```

The initializer accepts explicit local name/port/control-directory options; the CLI's simple init uses fixed defaults. Recovery refuses an existing target database. Copy only the original store wrapping key into the target's validated secret file. Keep the backup decryption key separate from its archive. Never copy an old control generation file or runtime database password. If preparation or maintenance fails, retain the private state and inspect the fenced condition; do not rerun initialization over an existing target or reset the generation.

Backups use AES-256-GCM with a fresh nonce and authenticated format header. The **entire** authentication tag is checked into a private temporary artifact before any restore database mutation. Wrong key/tamper therefore cannot partially restore a database. Failed/nonzero exports remove their incomplete archive and reap the child. Existing destinations are not overwritten. Archive size is bounded at 10 GiB. This is not a streaming zero-plaintext-memory claim: a temporary authenticated plaintext archive exists privately for `pg_restore` and is removed afterward.

All maintenance is serialized by an exclusive private lock. Fence/rotation rereads external generation, disables runtime login, terminates only the intended role/store sessions and replaces the runtime password before reopening LOGIN. Managed workers are recreated with new generation-specific private secret volumes. Unknown stale workers retain invalid database credentials; merely stopping known containers is insufficient. The HTTP and acceptance boundaries recheck the fence, including in-flight responses. A paused native write resumed after completed retirement is tested separately from an in-process flag.

Recovery preserves unrelated backed-up data, but creates a new signer/DID, issuer, verifier and signed-status cohort before reopening. Every restored old grant/token/request/credential cohort is rejected, including revocations lost by the stale archive. Downtime and credential reissue are deliberate. This is **not seamless signer rotation** or a revocation journal. Keep the old database/archive and protected key files as rollback evidence, but never reactivate an old cohort by resetting the external generation. Incomplete maintenance stays fenced/NOLOGIN for operator investigation; there is no automatic rollback that resurrects sessions.

## Signer retirement versus store rekey

`retire ... --apply` performs disruptive managed-cohort retirement and reissue. `rekey STATE /absolute/private-new-key --apply` separately calls native Askar wrapping-key rotation, retaining the signing identity and credential cohort. The new private file must meet the same ownership/mode/size rules as other secrets. A protected `rollback_store_key_GENERATION` file is retained outside the database; do not delete it before validating recovery. Qualification checks old-key open failure, new-key open success and continued verification of the pre-rekey credential. A store rekey is not a signing-key rotation.

## Telemetry, measured workload and artifacts

Optional API telemetry emits only fixed operation/method classes, status and elapsed time. It never logs URI/query, request/response body, authorization headers, member IDs or capability URLs. Caddy access/request logs are disabled; `/metrics` and detailed readiness are not exposed by the edge. Internal counters contain no subject labels. This is a small local diagnostic surface, not a full observability platform.

```sh
node --test ops/backup.test.mjs
node --test ops/deployment.test.mjs
node ops/signing.mjs qualify
node ops/artifacts.mjs /private/tmp/credspan-artifacts
```

The real deployment fixture measures 20 sequential authenticated result reads, including holder-proof and signed-status revalidation, and reports image ID, architecture, p50/p95 and observed memory. It is a bounded synthetic measurement, not an SLA or production load test. It also exercises least privilege/private mounts, Host/Origin denial, an independent modified-wallet issue/hold/present journey, separate stale-worker writes/HTTP fencing, tamper/wrong-key no-mutation, stale-backup no-resurrection, unrelated-data preservation and wrapping-key rotation. The common down helper explicitly includes the optional holder profile. The fixture removes both owned cross-network wallet endpoints before teardown, asserts exact deployment-UUID/control-volume absence and fails visibly on cleanup errors. It retains protected rollback files outside the repository. Earlier startup failures remain recorded separately; fixing leaked test wallets does not establish their cause. PostgreSQL startup failures now report bounded, exact-owned container state/health timestamps, numeric process results and fixed log categories before cleanup, without raw stderr or SQL. Controlled start/restart, absent-network, exited and unhealthy fixtures validate these distinctions; they do not retrospectively identify the earlier cause.

The artifact helper requires an image labeled with the exact clean source revision, exports its immutable local image ID, runs pinned Syft 1.57.1 and Trivy 0.76.2 against that archive, and hashes the image/SBOM/scan into a manifest. Scan findings remain findings; the installed legacy decoder advisory is not suppressed. See the dated [image risk baseline](image-risk.md) for exact OS components and bounded privilege assessment. Scan timestamps and databases matter. Runtime behavior on Linux arm64 is locally tested; prior amd64 native probes used emulation. Hosted/native-amd64 acceptance requires the actual current CI results; earlier local evidence alone does not establish it.

Cosign 3.1.4 uses its standard key-based Sigstore bundle with an explicitly empty signing-service configuration. Local qualification uses a disposable encrypted key, denies outbound proxy access, verifies the signature and rejects a tampered artifact. Private production signing keys are not generated/provisioned here. `--insecure-ignore-tlog` during verification acknowledges intentionally absent transparency evidence; it does not bypass signature validation. Set separate `COSIGN_KEY_FILE`/`COSIGN_PASSWORD` only for an authorized private signing operation. No transparency upload or artifact/image publication occurs in local qualification.

Before provisioning any signing secret, restrict the `private-release` environment deployment branches to **main only** and require operator approval. Workflow conditions alone are editable on another branch; the environment restriction is the secret-release trust boundary. These settings and a real signing key are not configured or qualified here.

The separate manual [private artifact workflow](../.github/workflows/release-artifacts.yml) uses only pinned GitHub-owned actions and a separately configured `private-release` environment/key. It refuses dispatches in public repositories and non-main dispatches and requires the latest exact-SHA main push CI run and its required `ci` job to succeed before building and again before signing. Build/scan runs in a separate job without signing secrets. The signing job verifies every image/SBOM/scan hash and the expected source revision before signing. Private workflow uploads include the image archive, manifest, SBOM and raw scan; the final upload also includes the signature bundle and public key. This is private Actions artifact storage, not registry/release publication. It has read-only repository permissions and no registry/release push. It has not been dispatched or supplied a real signing key. GitHub's native private-repository artifact attestations require Enterprise Cloud; Actions access alone does not establish that entitlement. Public HTTPS deployment, cloud/Kubernetes helpers, seamless signer cohorts and production MCP remain later work.
