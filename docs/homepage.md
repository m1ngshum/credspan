# Public homepage

Credspan's public introduction is a static site at **https://credspan.m1ngshum.com/**. It publishes only the files explicitly copied by `apps/site/build.mjs`. No API, management console code, repository contents, credentials or environment configuration are deployed. The console image is an actual disconnected synthetic-sandbox screenshot with no key or subject data.

The homepage is separate from the local and private hosted synthetic credential sandboxes and does not qualify production credential operations. Its copy states the modified-wallet compatibility limits and links to the public source repository. Hosted sandbox access remains private. Links are limited to this page, the canonical source repository and the builder's public homepage.

## Build and review

Use the repository's pinned Node.js version:

```sh
pnpm --filter @credspan/site check
pnpm check
```

The static site needs no runtime dependencies, JavaScript, cookies, analytics, forms or API connection. The homepage build copies canonical brand assets and browser icons from their existing sources; do not edit generated files in `apps/site/dist`.

## Netlify and DNS

- Resolve the operator team and project ID from the private deployment record. Do not commit those values.
- Published directory: `apps/site/dist`; configuration: root `netlify.toml`.
- Custom hostname: `credspan.m1ngshum.com`.
- Cloudflare DNS: a DNS-only CNAME from that hostname to `m1ngshum-credspan.netlify.app`. The apex, other subdomains, nameservers and email records remain separate.
- Netlify provides HTTPS for the custom hostname. Keep the record DNS-only for direct Netlify certificate validation and delivery.

Deployment is currently manual from reviewed source, using the authenticated Netlify CLI. Git continuous deployment is not connected. The existing operational repository and deployment record remain private; source publication does not connect continuous deployment. Review the exact source commit, build the allowlisted output, create a draft deploy and verify it before the explicit production deploy. Select the homepage workspace explicitly to avoid the CLI's interactive monorepo prompt:

Set `NETLIFY_SITE_ID` privately to the intended project ID; do not paste it into this document.

```sh
node apps/site/build.mjs
netlify deploy --filter @credspan/site --site "${NETLIFY_SITE_ID:?Set the intended project ID}" --dir apps/site/dist --no-build
netlify deploy --filter @credspan/site --site "${NETLIFY_SITE_ID:?Set the intended project ID}" --dir apps/site/dist --no-build --prod
```

The final command publishes publicly. Do not deploy the repository root or `apps/console/dist`, add API rewrites, or change site-wide access controls on unrelated projects. `.netlify` local state is ignored. For subsequent changes, repeat the exact-source review and preview checks before publishing; a failed deploy leaves the prior successful version live.
