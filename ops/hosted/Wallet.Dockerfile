FROM node:26.13.1-trixie@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac AS source
WORKDIR /source
# The exact public revision and three patches are integrity checked.
RUN git clone --depth 1 --branch v1.2.1 https://github.com/walt-id/waltid-identity.git . && test "$(git rev-parse HEAD)" = cf3c836cc78a9e64b2fd87933527327972e014da
COPY vendor/waltid/preauthorized-only.patch /preauth.patch
COPY vendor/waltid/access.patch /access.patch
COPY vendor/waltid/dependencies.patch /dependencies.patch
RUN echo '32cb0096a32693e17674038caa316605822c4b879e9cf5fad41008ea50b33041  /dependencies.patch' | sha256sum -c - && git apply --check /dependencies.patch && git apply /dependencies.patch && echo 'ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa  /preauth.patch' | sha256sum -c - && echo 'd749318eda575f40399b9338814496753935a733cc9a965b138cc4ea151eff9f  /access.patch' | sha256sum -c - && git apply --check /preauth.patch && git apply /preauth.patch && git apply --check /access.patch && git apply /access.patch
FROM eclipse-temurin:21-jdk@sha256:0a3f329821dcadf54b2a3033a15e2e9f007069a9db43d7f51897e6b80e726b07 AS build
WORKDIR /source
COPY --from=source /source /source
RUN timeout 3300 ./gradlew :waltid-libraries:protocols:waltid-openid4vci:jvmTest :waltid-services:waltid-wallet-api2:test :waltid-services:waltid-wallet-api2:installDist :waltid-libraries:web:waltid-web-data-fetching:jvmTest --tests id.walt.webdatafetching.engines.CredspanAccessTest :waltid-libraries:web:waltid-web-data-fetching:jvmJar -Pversion=1.2.1 '-Dorg.gradle.jvmargs=-Xmx4g -XX:+UseParallelGC -Dfile.encoding=UTF-8' --no-daemon --max-workers=2
RUN mkdir /runtime && cp waltid-services/waltid-wallet-api2/build/install/waltid-wallet-api2/lib/* /runtime/ && cp LICENSE NOTICE.md THIRD-PARTY-NOTICE.md /runtime/ && cp waltid-services/waltid-wallet-api2/THIRD-PARTY-NOTICE.md /runtime/wallet-THIRD-PARTY-NOTICE.md
RUN sed -n 's|^CLASSPATH=||p' waltid-services/waltid-wallet-api2/build/install/waltid-wallet-api2/bin/waltid-wallet-api2 | sed 's|[$]APP_HOME/lib/|/app/libs/|g' > /runtime/classpath && test "$(wc -l < /runtime/classpath)" -eq 1 && grep -Eq '^/app/libs/waltid-wallet-api2-1[.]2[.]1[.]jar(:/app/libs/[a-zA-Z0-9_.-]+[.]jar)*$' /runtime/classpath && tr ':' '\n' < /runtime/classpath | sed 's|^/app/libs/||' | sort > /classpath-files && find /runtime -maxdepth 1 -type f -name '*.jar' -printf '%f\n' | sort > /runtime-files && cmp /classpath-files /runtime-files


FROM --platform=linux/amd64 waltid/wallet-api2:1.2.1@sha256:7937cfe2450e5521e272615179baef66f805459df391f2321b2f20ad92468614
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources && apt-get -o Acquire::Retries=0 update && apt-get -o Acquire::Retries=0 install -y --no-install-recommends apt=3.2.1ubuntu0.1 libapt-pkg7.0=3.2.1ubuntu0.1 libc6=2.43-2ubuntu2.7 libc-bin=2.43-2ubuntu2.7 libc-gconv-modules-extra=2.43-2ubuntu2.7 locales=2.43-2ubuntu2.7 libpcre2-8-0=10.46-1ubuntu0.1 perl-base=5.40.1-7ubuntu0.4 && rm -rf /var/lib/apt/lists/* /app /usr/bin/pebble && mkdir -p /app/libs
LABEL credspan.dependencies.patch.sha256="32cb0096a32693e17674038caa316605822c4b879e9cf5fad41008ea50b33041"
LABEL org.opencontainers.image.revision="cf3c836cc78a9e64b2fd87933527327972e014da" credspan.probe.patch.sha256="ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa" credspan.access.patch.sha256="d749318eda575f40399b9338814496753935a733cc9a965b138cc4ea151eff9f"
COPY --from=build /runtime/ /app/libs/
COPY --from=build /runtime/classpath /app/jib-classpath-file
COPY ops/hosted/wallet-config/ /waltid-wallet-api2/config/
COPY ops/hosted/wallet-bootstrap.sh /wallet-bootstrap.sh
USER 0:0
ENTRYPOINT ["sh", "/wallet-bootstrap.sh"]
EXPOSE 7006
