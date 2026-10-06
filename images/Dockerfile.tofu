FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS fetch
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac && curl -fsSLo "/tmp/tofu_1.13.1_linux_$a.tar.gz" "https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_linux_$a.tar.gz" && curl -fsSLo /tmp/SHA256SUMS "https://github.com/opentofu/opentofu/releases/download/v1.13.1/tofu_1.13.1_SHA256SUMS" && (cd /tmp && grep " \*\?tofu_1.13.1_linux_$a.tar.gz$" SHA256SUMS | sed 's/ \*/  /' | sha256sum -c -) && mkdir -p /out && tar -xzf "/tmp/tofu_1.13.1_linux_$a.tar.gz" -C /out tofu
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /usr/local --no-save --omit=dev --no-audit --no-fund @cdktn/hcl2json@0.24.0 && npm cache clean --force
COPY --from=fetch /out/ /usr/local/bin/
COPY --chmod=0755 packages/terragucci/dist/terragucci.mjs /usr/local/bin/terragucci
LABEL org.opencontainers.image.title="terragucci-tofu"
LABEL org.opencontainers.image.description="OpenTofu 1.13.1 and the terragucci engine"
LABEL org.opencontainers.image.version="0.2.1"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"
LABEL org.opencontainers.image.licenses="Apache-2.0"
CMD ["bash"]
