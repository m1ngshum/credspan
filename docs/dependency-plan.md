# Dependency compatibility targets

The original table below records historical pre-implementation candidates checked on 2026-11-12. Installed PR2 decisions are recorded at the end of this file and in [the current compatibility record](compatibility.md); the candidate table is not an installed-dependency inventory.

Public npm metadata was checked on 2026-11-12. These are implementation candidates, not installed dependencies or tested interoperability. Recheck peer dependencies and security advisories when adding each package. The foundation-only stage used Node's standard library; the API workspace now installs the runtime packages selected below.

| Component | Exact candidate | Constraint/evidence |
| --- | --- | --- |
| Node.js | 26.13.1 | Foundation runtime pin; local runtime checked |
| pnpm | 12.18.0 | Public registry latest at check time |
| TypeScript | 6.0.3 | Candidate selected for Swagger compatibility; revalidate its actual peer range in PR2 |
| NestJS core | 12.4.2 | Public registry version exists |
| Express | 5.3.0 | Public registry version exists |
| Credo packages | 0.7.4 | Align all selected Credo packages; recheck each before install |
| drizzle-orm | 0.44.7 | @credo-ts/drizzle-storage@0.7.4 requires ^0.44.6 |
| @openwallet-foundation/askar-nodejs | 0.6.1 | Public registry version exists |
| @openwallet-foundation/askar-shared | 0.6.1 | @credo-ts/askar@0.7.4 permits ^0.4.3, ^0.5.0, or ^0.6.0; excludes 0.7 |
| PostgreSQL | 18.6 | Planned server target; container and integration validation deferred to PR2 |
| React | 19.3.1 | Public registry version exists |
| Vite | 8.3.8 | Public registry version exists |

Use the current `@openwallet-foundation` Askar packages, not the old `@hyperledger/aries-askar-nodejs` package name. walt.id Wallet API v2 is an external contract: verify the chosen deployment/version and API schema in PR2 rather than assuming compatibility from package versions.

## Candidate security blockers

A disposable npm audit on 2026-11-12 of Credo core/node/askar/openid4vc/drizzle-storage 0.7.4, Drizzle 0.44.7 and OpenWallet Foundation Askar 0.6.1 reported known advisories. None of these packages is installed in this foundation:

- Drizzle 0.44.7 is affected by [SQL identifier injection](https://github.com/advisories/GHSA-gpj5-g38j-94v9). The patched 0.45.2 version falls outside the Credo adapter's `^0.44.6` peer range.
- Transitive `@sd-jwt/decode` versions are affected by [silently dropped tampered disclosures](https://github.com/advisories/GHSA-f9j6-8p6x-r9j6).
- The graph also includes an affected esbuild development-server dependency ([advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99)).

The audit offered no fix within that candidate graph. Runtime reachability has not been established. PR2 must resolve the dependency selection and verify affected paths before treating the stack as accepted; peer compatibility and a successful install alone are insufficient. Do not force an incompatible override to make the audit quiet.

## Compatibility implementation selection

The API now installs exact NestJS 12.4.2 / Express 5.3.0 / Credo 0.7.5 / OWF Askar 0.6.1, with native Askar PostgreSQL storage. Drizzle and drizzle-kit are absent. `@openid4vc/oauth2` is pinned to **0.6.0**, matching Credo's `^0.6.0` dependency: newer 0.9.x error classes are distinct at runtime and break Credo's `instanceof` protocol-error handling. TypeScript 6.0.3 builds the slice. Installed UI/contract tooling is Swagger 12.1.1, React 19.3.1, Vite 8.3.8 and plugin-react 6.3.0; Hey API openapi-ts 0.99.0 generates the bundled Fetch SDK. The one qualified child-only parser→js-yaml 4.3.2 security override is documented in [dependency patch provenance](dependency-patches.md), not a blanket override. PR7 adds exact @modelcontextprotocol/server/client/core 2.4.0 with Zod 4.6.7; only server/Zod are direct MCP runtime dependencies, client is test-only and core is SDK-aligned transitively. Dev-only jose 6.2.17 constructs actual encrypted JARM negative-test responses. Native build scripts are explicitly allowed only for Askar, koffi and cbor-extract. See [compatibility limits](compatibility.md) for residual installed advisories.

On 2026-11-28, the [Credo 0.7.5 release](https://github.com/openwallet-foundation/credo-ts/releases/tag/v0.7.5) and npm package metadata were checked. OpenID4VC 0.7.5 requires Core 0.7.5 exactly, so the API updates Core, Node, Askar and OpenID4VC together. OAuth2 remains pinned to 0.6.0 and both OWF Askar packages remain pinned to 0.6.1.
