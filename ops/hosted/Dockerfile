FROM --platform=linux/amd64 node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /source
RUN npm install --global pnpm@12.18.0 --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY ops/fetch-native.mjs ops/seed-native.mjs ops/native-lock.json ops/
RUN node ops/fetch-native.mjs && mkdir -p /opt/credspan-native && cp -r ops/.cache/native/. /opt/credspan-native/
RUN pnpm install --frozen-lockfile --ignore-scripts && node ops/seed-native.mjs && pnpm rebuild @openwallet-foundation/askar-nodejs koffi cbor-extract
COPY apps apps
COPY packages packages
COPY docs/assets/brand docs/assets/brand
RUN pnpm -r build && pnpm --filter @credspan/api deploy --prod --legacy /runtime

FROM --platform=linux/amd64 gcr.io/distroless/nodejs26-debian13:nonroot@sha256:767ffb7e2ffa9f4280f1af7b99f7f0a1cafb79d0dcc0e0d3aba43843748008a5
ENV PATH="/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENTRYPOINT []
ARG SOURCE_REVISION=unqualified
LABEL org.opencontainers.image.source="https://github.com/m1ngshum/credspan" org.opencontainers.image.revision=$SOURCE_REVISION
WORKDIR /app/apps/api
COPY --from=build /runtime ./
COPY --from=build /source/apps/console/dist /app/apps/console/dist
COPY ops/init-volumes.mjs /app/ops/init-volumes.mjs
COPY ops/hosted/bootstrap.mjs /app/ops/hosted-bootstrap.mjs
USER 0:0
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=4s --start-period=10s CMD ["node", "-e", "const r=require('node:http').get({hostname:'127.0.0.1',port:3000,path:'/health/ready',headers:{host:'healthcheck.railway.app'}},s=>{s.resume();if(s.statusCode!==200)process.exit(1)});r.setTimeout(3000,()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1))"]
CMD ["node", "/app/ops/hosted-bootstrap.mjs"]
