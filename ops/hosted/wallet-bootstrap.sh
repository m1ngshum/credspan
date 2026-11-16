#!/bin/sh
set -eu
[ "${CREDSPAN_ACCESS_ORIGIN:-}" = 'https://credspan-sandbox.m1ngshum.com' ]
[ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]
mkdir -p /waltid-wallet-api2/data
chown -R 10001:10001 /waltid-wallet-api2/data
exec setpriv --reuid=10001 --regid=10001 --clear-groups java -cp @/app/jib-classpath-file id.walt.wallet2.MainKt
