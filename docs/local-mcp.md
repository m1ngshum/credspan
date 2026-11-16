# Optional local MCP tools

This stdio server has exactly three tools for the synthetic local sandbox. It does not expose active issuance/revocation operations, custody keys, a remote endpoint or production MCP authorization. Nothing here installs global MCP client configuration. Use a trusted local machine and the pinned Node 26.13.1/pnpm 12.18.0.

```sh
pnpm install --frozen-lockfile
pnpm --filter @credspan/mcp build
```

Configure your chosen client manually. Use the actual absolute Node executable and repository path; launch Node directly so package-manager stdout cannot corrupt JSON-RPC. Example configuration only:

```toml
[mcp_servers.credspan_local]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/credspan/packages/mcp/dist/src/main.js"]
```

The default launch permits diagnostics and proposals; test execution returns `disabled`. To authorize isolated synthetic execution, explicitly add `--allow-sandbox-tests` to that trusted startup argument list. A caller-provided `confirmed:true`, a tool annotation or an environment flag cannot grant this capability. Unknown startup arguments fail closed. Do not add management/store/cloud keys to this configuration.

| Tool | Input | Behavior |
| --- | --- | --- |
| `diagnostics` | `{}` | Fixed booleans for pinned Node, supported platform, local Docker/cached images, opt-in, busy and cleanup state; no active API or credential reads |
| `propose_config` | `{"port":8080,"bind":"loopback"}` | Nonsecret loopback/canonical URL proposal, always `applied:false`; no files, port reservation or deployment |
| `run_sandbox_test` | `{"scenario":"membership-roundtrip"}` or `{"scenario":"revocation"}` | Fresh independent-wallet synthetic scenario plus exact owned cleanup; requires startup opt-in |

Schemas reject unknown fields. Callers cannot supply commands, SQL, paths, URLs, environment, credential IDs, alternate images or arbitrary timeouts. Proposals do not certify port availability, public HTTPS or production readiness. Tool hints are not authorization. Results contain executed assertions and cleanup status, never raw credentials, capabilities, keys, subject attributes, child logs or environment dumps.

## Runtime prerequisites and scope

The runner uses the qualified [operations primitives](operations.md) with a fresh private project/control directory, random keys/store and isolated network. The only exposed service ports are loopback edge/wallet ports. It preserves the canonical wallet URLs unchanged. No active deployment environment or `.env` is loaded. Child environment is an explicit allowlist: PATH/locale plus the validated local Unix Docker endpoint, a private temporary Docker configuration and temporary directory. Active management/Askar/PostgreSQL/control/URL/trust/cloud/GitHub/npm/Cosign settings and NODE_OPTIONS/NODE_PATH are excluded. Read-only Docker context/plugin discovery uses only the required local Docker configuration; those settings/credentials are not copied into the runner.

All four images must already be cached. The explicit operator/CI preparation command `node ops/cache-sandbox-images.mjs` pulls only the digest-pinned PostgreSQL/Caddy references from `ops/images.json`, through the local Docker boundary. MCP does not build, install or pull implicitly. `credspan-api:local` is resolved to its immutable image ID and must match the clean API source SHA and canonical repository URL in `packages/mcp/runtime.json`, and the native host architecture. The peer must carry both reviewed patch labels. Image labels are a trusted-local-operator precondition, not cryptographic release authority. Do not substitute an old private-history image or interpret a source label as proof of qualification.

Build the pinned clean API checkout separately, then build the [modified peer](../vendor/waltid/README.md). The following target must not already exist; the detached worktree leaves the current branch unchanged:

```sh
runtime_revision="$(node --input-type=module -e 'import{readFileSync}from"node:fs";console.log(JSON.parse(readFileSync("packages/mcp/runtime.json","utf8")).apiSource)')"
git worktree add --detach /private/tmp/credspan-reviewed-runtime "$runtime_revision"
(cd /private/tmp/credspan-reviewed-runtime && node ops/build.mjs)
node vendor/waltid/build-peer.mjs
node ops/cache-sandbox-images.mjs
```

`packages/mcp/runtime.json` and CI’s source checkout must change together after a newly qualified runtime revision. A build of another source revision is intentionally rejected. Local tests use macOS arm64 with Linux arm64 containers; hosted MCP CI uses Linux ARM64. Every new head requires its own CI. Native AMD64 MCP behavior remains unqualified until corresponding checks run. Windows and remote Docker daemons are unsupported.

## Cancellation and cleanup

The MCP parent remains asynchronous while the fixed runner uses the existing operations helper in a separate process group. One run is allowed across server factory instances and separately launched copies sharing the user's temporary namespace. The private exclusive lease is not stolen automatically. The execution budget is fixed at 120 seconds, followed by a cleanup budget of 30 seconds. Process-group retirement can add up to roughly three seconds per active group; these are budgets, not a strict 150-second wall-clock guarantee. Callers cannot increase them. Subprocess output is bounded and never forwarded raw. Cleanup tolerates a listed container disappearing before inspection/removal only when a successful daemon query proves that exact immutable full ID is absent. Wrong ownership, malformed metadata, failed absence queries, timeouts and process-retirement failures remain fail-closed; quiet-pass checks still run. Failed cleanup retains the recovery lease and reports only fixed `cleanupFailure.stage` and `cleanupFailure.code` values through results/diagnostics, never raw Docker errors, paths or resource IDs. Cancellation can finish the client call before server cleanup completes, so callers must inspect the resulting cleanup state rather than treating the abort response as cleanup proof.

Cancellation, stdin EOF, SIGTERM, malformed JSON-RPC, oversized frames and transport closure stop active work. TERM→KILL escalation terminates the owned process group, including descendants retaining pipes or ignoring TERM, before Docker cleanup. Node observes its direct child; orphan descendant reaping belongs to the operating-system reaper. A still-observable group after the retirement budget fails closed with `cleanup_required`, including unreaped zombies. Tests capture Linux process identity/state, require stopped side effects and bounded eventual PID disappearance; signal-0 presence alone does not establish that a process is executing. The SDK itself ignores syntax-invalid non-JSON lines; they execute no tool, and the 64 KiB transport bound still applies. Valid JSON with an invalid JSON-RPC shape is rejected and closes this server. No custom wire protocol parser is substituted.

Cleanup uses a parent-generated UUID, exact allowed service/resource names and inspected ownership labels/IDs; it never prunes Docker or deletes by prefix. The control volume has its own exact path-derived ownership label and is checked separately. Creation intent survives interrupted child initialization; an internally supplied, validated operations deployment UUID binds resources before any creation. It is not a tool parameter. A successful run reports `cleanupComplete:true` only after owned Docker resources and private state are removed. Cancelled requests receive no late reply; diagnostics remains available to observe busy/cleanup state, and the server can run another test after cleanup.

A filesystem/Docker/process retirement failure returns `cleanup_required`, prevents further runs and retains a private lease with exact UUID/name/directory evidence. EOF/SIGTERM/transport-error shutdown then exits nonzero with the fixed `mcp_cleanup_required` code on stderr; a transport error also emits the fixed `mcp_protocol_error` code. The namespace is `credspan-mcp-UID` under the process temporary directory. Investigate the owned manifest/labels and remove only those exact resources before manually clearing a stale lease. Do not reset an active deployment or use prefix/prune cleanup. Abrupt SIGKILL/host failure cannot promise immediate cleanup; do not interpret a retained lease as permission to steal it.

## Validation and compatibility

```sh
pnpm --filter @credspan/mcp check
pnpm test:mcp
```

Unit tests cover actual TERM-ignoring descendants with retained/closed pipes; real stdio modern/legacy tool discovery/calls, validation and disabled capability; bounded frames/invalid protocol; and diagnostics cancellation/EOF with a controlled real subprocess plus healthy follow-up. The controlled subprocess is lifecycle evidence, not wallet interoperability evidence.

Docker integration uses actual official SDK clients and the independent modified wallet: legacy issue/hold/present and modern issue/hold/present/revoke; active-config/NODE_OPTIONS isolation; global cross-instance busy lease; cancellation and same-server reuse; real partial init failure/deadline/EOF/SIGTERM; denied cleanup, including during an oversized active request; exact control-volume absence; and unrelated container/volume preservation. No credential protocol response is mocked. Raw outputs remain outside source; only sanitized assertions are returned.

Exact server/client/core **2.4.0** and Zod **4.6.7** are registry-verified stable releases. The runtime imports server/Zod only; client is test-only. `serveStdio(factory)` supports explicit legacy **2025-11-25** and modern **2026-07-28** here. The official client defaults to legacy; tests explicitly pin modern negotiation. Even pinned modern negotiation can launch a discovery sibling, so process startup/factory construction never creates leases/resources. Cancellation uses the released `ctx.mcpReq.signal`. This does not claim every native desktop client was tested. The full application graph retains the [legacy decoder advisory](compatibility.md), and runtime images retain their documented [OS findings](image-risk.md). Hosted green CI and exact-head review remain merge gates.
