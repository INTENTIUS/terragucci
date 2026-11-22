FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS fetch
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=amd64 ;; (arm64) w=arm64 ;; (*) echo "tofu 1.13.9: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="tofu_1.13.9_linux_$w.tar.gz" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://github.com/opentofu/opentofu/releases/download/v1.13.9/$f" && case "$a" in (amd64) want=b34b327cc1ef07178207b6f2cd1f5276537d3e5b7be316500f6dac50d4c0a857 ;; (arm64) want=5dc196dde75b667e4806d358310ec96742774cd0993c54c1237efee5644b69b8 ;; (*) want= ;; esac && curl -fsSLo "$t/sums" "https://github.com/opentofu/opentofu/releases/download/v1.13.9/tofu_1.13.9_SHA256SUMS" && line="$(sed -n "s#^\([0-9a-f]\{64\}\)  *[*.]*/*$f\$#\1#p" "$t/sums")" && { [ -n "$line" ] || { echo "tofu 1.13.9: $f is not in tofu_1.13.9_SHA256SUMS" >&2; exit 1; }; } && { [ -z "$want" ] || [ "$line" = "$want" ] || { echo "tofu 1.13.9: tofu_1.13.9_SHA256SUMS lists $line for $f; chant records $want" >&2; exit 1; }; } && want="$line" && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/terragucci/tofu-1.13.9" && tar -xzf "$t/$f" -C "$t" "tofu" && install -m 0755 "$t/tofu" "/opt/terragucci/tofu-1.13.9/tofu"
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ARG CHANT_RELEASE_LABEL
ENV USER=terragucci
ENV HOME=/tmp
ENV NODE_DISABLE_COMPILE_CACHE=1
ENV npm_config_logs_max=0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
RUN git config --system --add safe.directory '*'
RUN npm install --prefix /usr/local --no-save --omit=dev --no-audit --no-fund @intentius/chant@0.124.115 @cdktn/hcl2json@0.24.0 && npm cache clean --force && rm -rf /tmp/.npm
RUN cd /tmp && npm pack --silent @intentius/chant@0.124.115 && tar -xzf intentius-chant-0.124.115.tgz package/dist/wave-runtime.mjs && install -D -m 0644 package/dist/wave-runtime.mjs /opt/chant/wave-runtime.mjs && printf '#!/bin/sh\nexec node /opt/chant/wave-runtime.mjs "$@"\n' > /usr/local/bin/chant && chmod 0755 /usr/local/bin/chant && rm -rf /tmp/package /tmp/intentius-chant-*.tgz && npm cache clean --force && rm -rf /tmp/.npm
COPY --from=fetch /opt/terragucci/ /opt/terragucci/
RUN ln -sf /opt/terragucci/tofu-1.13.9/tofu /usr/local/bin/tofu
COPY --chmod=0755 packages/terragucci/dist/terragucci.mjs /usr/local/bin/terragucci
LABEL org.opencontainers.image.title="terragucci-tofu"
LABEL org.opencontainers.image.description="OpenTofu 1.13.9 and the terragucci engine"
LABEL org.opencontainers.image.version="${CHANT_RELEASE_LABEL}"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.base.name="node:22-bookworm-slim"
LABEL org.opencontainers.image.base.digest="sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee"
LABEL io.intentius.chant.image.base="debian"
CMD ["bash"]
