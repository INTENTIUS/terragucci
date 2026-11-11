FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS fetch
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -e; a="$TARGETARCH" && case "$a" in (amd64) w=amd64 ;; (arm64) w=arm64 ;; (*) echo "tofu 1.13.1: chant fetches it for amd64 and arm64, not $a" >&2; exit 1 ;; esac && f="tofu_1.13.1_linux_$w.tar.gz" && t="$(mktemp -d)" && curl -fsSLo "$t/$f" "https://github.com/opentofu/opentofu/releases/download/v1.13.1/$f" && case "$a" in (amd64) want=378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69 ;; (arm64) want=9c1ef375aa1852db0b2888aa921b640c71f8140d4682aa4fec99378a64fa7dc3 ;; (*) want= ;; esac && curl -fsSLo "$t/sums" "https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_SHA256SUMS" && line="$(sed -n "s#^\([0-9a-f]\{64\}\)  *[*.]*/*$f\$#\1#p" "$t/sums")" && { [ -n "$line" ] || { echo "tofu 1.13.1: $f is not in tofu_1.13.1_SHA256SUMS" >&2; exit 1; }; } && { [ -z "$want" ] || [ "$line" = "$want" ] || { echo "tofu 1.13.1: tofu_1.13.1_SHA256SUMS lists $line for $f; chant records $want" >&2; exit 1; }; } && want="$line" && echo "$want  $t/$f" | sha256sum -c - >/dev/null && mkdir -p "/opt/terragucci/tofu-1.13.1" && tar -xzf "$t/$f" -C "$t" "tofu" && install -m 0755 "$t/tofu" "/opt/terragucci/tofu-1.13.1/tofu"
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG CHANT_RELEASE_LABEL
ENV USER=terragucci
ENV HOME=/tmp
ENV NODE_DISABLE_COMPILE_CACHE=1
ENV npm_config_logs_max=0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* /var/log/apt/* /var/log/dpkg.log /var/cache/ldconfig/aux-cache
RUN git config --system --add safe.directory '*'
RUN npm install --prefix /usr/local --no-save --omit=dev --no-audit --no-fund @cdktn/hcl2json@0.24.0 && npm cache clean --force && rm -rf /tmp/.npm
RUN cd /tmp && npm pack --silent @intentius/chant@0.124.91 && tar -xzf intentius-chant-0.124.91.tgz package/dist/wave-runtime.mjs && install -D -m 0644 package/dist/wave-runtime.mjs /opt/chant/wave-runtime.mjs && printf '#!/bin/sh\nexec node /opt/chant/wave-runtime.mjs "$@"\n' > /usr/local/bin/chant && chmod 0755 /usr/local/bin/chant && rm -rf /tmp/package /tmp/intentius-chant-*.tgz && npm cache clean --force && rm -rf /tmp/.npm
COPY --from=fetch /opt/terragucci/ /opt/terragucci/
RUN ln -sf /opt/terragucci/tofu-1.13.1/tofu /usr/local/bin/tofu
COPY --chmod=0755 packages/terragucci/dist/terragucci.mjs /usr/local/bin/terragucci
LABEL org.opencontainers.image.title="terragucci-tofu"
LABEL org.opencontainers.image.description="OpenTofu 1.13.1 and the terragucci engine"
LABEL org.opencontainers.image.version="${CHANT_RELEASE_LABEL}"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"
LABEL org.opencontainers.image.licenses="Apache-2.0"
CMD ["bash"]
