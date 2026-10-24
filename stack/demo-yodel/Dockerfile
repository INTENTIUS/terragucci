# The demo's job image: terragucci's tofu CI image with SQL Yodeler and
# choudoufu beside it, so app's wave runs app/schema's migrations
# (example-demo/app/main.tf) and a demo tree whose terragucci.yml says
# binary: choudoufu runs its roots on it. stack/demo.sh up builds it as
# terragucci-demo-tofu:local, and tags it terragucci-demo-choudoufu:local too.
# Each such tree's terragucci.yml names one of them as the image every job runs
# in: a tree whose roots run on choudoufu names the second.
#
#   BASE                the tofu CI image (scripts/images.ts tags)
#   CHOUDOUFU_VERSION   the choudoufu release (stack/demo.sh's CHOUDOUFU_VERSION)
#   CHOUDOUFU_FROM      release (the default) or source
#   CHOUDOUFU_REF       with source, the commit of INTENTIUS/choudoufu to build
#                       (stack/demo.sh's CHOUDOUFU_REF): a change composed
#                       estates need, which no release carries yet
#
# yodel, chant and the sql lexicon come from SQL Yodeler's own CI image, pinned
# by digest, under /opt/yodel. Nothing here puts them on PATH or in a
# node_modules terragucci resolves from: the wave's chant stays the tofu
# image's. The migration step puts /opt/yodel/node_modules/.bin on its own PATH
# and links /opt/yodel/node_modules into the project.
#
# choudoufu comes from its GitHub release, checked against the sha256 that
# choudoufu.sha256 records for the version and arch, and goes to
# /usr/local/bin/choudoufu. With CHOUDOUFU_FROM=source it is built from the
# commit CHOUDOUFU_REF names instead (go build ./cmd/choudoufu), and the release
# is not downloaded.
#
# hashicorp/aws (AWS_PROVIDER_VERSION) comes from its release zip, checked
# against aws-provider.sha256 and the release's SHA256SUMS, and goes into a
# filesystem mirror under /opt/terragucci-demo/providers. Only a tree whose
# TF_CLI_CONFIG_FILE names /etc/terragucci-demo/tofu-mirror.tfrc installs from
# it (example-demo-fanout); every other tree's init is as it was.
ARG BASE
ARG CHOUDOUFU_FROM=release
FROM ghcr.io/intentius/sql-yodeler:0.9.0@sha256:15f7406fd59f2f74f4299de0fb6121c9905278276aac86dde993e2223eb97946 AS yodel
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
FROM fetch AS choudoufu-release
ARG TARGETARCH
ARG CHOUDOUFU_VERSION
COPY choudoufu.sha256 /tmp/choudoufu.sha256
RUN set -e; case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac; \
  v="${CHOUDOUFU_VERSION:?pass --build-arg CHOUDOUFU_VERSION}"; f="choudoufu_v${v}_linux_${a}.tar.gz"; \
  sum="$(awk -v v="$v" -v a="$a" '$1 == v && $2 == a { print $3 }' /tmp/choudoufu.sha256)"; \
  [ -n "$sum" ] || { echo "choudoufu.sha256 records no sha256 for choudoufu $v on $a" >&2; exit 1; }; \
  curl -fsSLo "/tmp/$f" "https://github.com/INTENTIUS/choudoufu/releases/download/v${v}/$f"; \
  echo "$sum  /tmp/$f" | sha256sum -c -; \
  mkdir -p /out && tar -xzf "/tmp/$f" -C /out choudoufu
# The same binary, built from a commit of INTENTIUS/choudoufu. go.mod names the
# toolchain it needs, which GOTOOLCHAIN=auto fetches when the image's is older.
FROM --platform=$BUILDPLATFORM golang:1.27 AS choudoufu-source
ARG TARGETARCH
ARG CHOUDOUFU_REF
RUN set -e; \
  [ -n "${CHOUDOUFU_REF:-}" ] || { echo "pass --build-arg CHOUDOUFU_REF with CHOUDOUFU_FROM=source" >&2; exit 1; }; \
  git init -q /src; cd /src; \
  git remote add origin https://github.com/INTENTIUS/choudoufu.git; \
  git fetch -q --depth 1 origin "$CHOUDOUFU_REF"; \
  git checkout -q FETCH_HEAD; \
  case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac; \
  GOTOOLCHAIN=auto CGO_ENABLED=0 GOOS=linux GOARCH="$a" go build -trimpath -ldflags "-s -w" -o /out/choudoufu ./cmd/choudoufu
FROM choudoufu-${CHOUDOUFU_FROM} AS choudoufu
# The Atmos CLI the Atmos demo's workflow runs, checked against the release's SHA256SUMS.
FROM fetch AS atmos
ARG TARGETARCH
ARG ATMOS_VERSION=1.230.1
RUN set -e; case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac; \
  f="atmos_${ATMOS_VERSION}_linux_${a}"; base="https://github.com/cloudposse/atmos/releases/download/v${ATMOS_VERSION}"; \
  curl -fsSLo "/tmp/$f" "$base/$f"; curl -fsSLo /tmp/SHA256SUMS "$base/atmos_${ATMOS_VERSION}_SHA256SUMS"; \
  (cd /tmp && grep "  $f\$" SHA256SUMS | sha256sum -c -); \
  mkdir -p /out && install -m 0755 "/tmp/$f" /out/atmos
FROM fetch AS awsprovider
ARG TARGETARCH
ARG AWS_PROVIDER_VERSION=6.67.0
COPY aws-provider.sha256 /tmp/aws-provider.sha256
RUN set -e; case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac; \
  v="$AWS_PROVIDER_VERSION"; f="terraform-provider-aws_${v}_linux_${a}.zip"; \
  base="https://github.com/opentofu/terraform-provider-aws/releases/download/v${v}"; \
  sum="$(awk -v v="$v" -v a="$a" '$1 == v && $2 == a { print $3 }' /tmp/aws-provider.sha256)"; \
  [ -n "$sum" ] || { echo "aws-provider.sha256 records no sha256 for hashicorp/aws $v on $a" >&2; exit 1; }; \
  curl -fsSLo "/tmp/$f" "$base/$f"; \
  curl -fsSLo /tmp/SHA256SUMS "$base/terraform-provider-aws_${v}_SHA256SUMS"; \
  echo "$sum  /tmp/$f" | sha256sum -c -; \
  (cd /tmp && grep "  $f\$" SHA256SUMS | sha256sum -c -); \
  mkdir -p /providers/registry.opentofu.org/hashicorp/aws && mv "/tmp/$f" /providers/registry.opentofu.org/hashicorp/aws/
FROM ${BASE}
COPY --from=yodel /opt/yodel /opt/yodel
COPY --from=choudoufu /out/choudoufu /usr/local/bin/choudoufu
COPY --from=atmos /out/atmos /usr/local/bin/atmos
COPY --from=awsprovider /providers /opt/terragucci-demo/providers
COPY tofu-mirror.tfrc /etc/terragucci-demo/tofu-mirror.tfrc
ARG CHOUDOUFU_VERSION
LABEL org.opencontainers.image.title="terragucci-demo-tofu"
LABEL org.opencontainers.image.description="terragucci's tofu CI image with SQL Yodeler 0.9.0, choudoufu ${CHOUDOUFU_VERSION} and a hashicorp/aws mirror, for the demo's jobs"
