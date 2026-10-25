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
# The module cache (with any toolchain GOTOOLCHAIN fetched) and the build cache
# are BuildKit cache mounts, which the daemon keeps between builds: a moved
# CHOUDOUFU_REF downloads only the modules that changed and compiles only the
# packages that did, instead of a cold `go build` (10+ minutes on the demo
# host's 4 vCPUs). Neither cache ends up in the image.
FROM --platform=$BUILDPLATFORM golang:1.27 AS choudoufu-source
ARG TARGETARCH
ARG CHOUDOUFU_REF
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  set -e; \
  [ -n "${CHOUDOUFU_REF:-}" ] || { echo "pass --build-arg CHOUDOUFU_REF with CHOUDOUFU_FROM=source" >&2; exit 1; }; \
  git init -q /src; cd /src; \
  git remote add origin https://github.com/INTENTIUS/choudoufu.git; \
  git fetch -q --depth 1 origin "$CHOUDOUFU_REF"; \
  git checkout -q FETCH_HEAD; \
  case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac; \
  GOTOOLCHAIN=auto CGO_ENABLED=0 GOOS=linux GOARCH="$a" go build -trimpath -ldflags "-s -w" -o /out/choudoufu ./cmd/choudoufu
FROM choudoufu-${CHOUDOUFU_FROM} AS choudoufu
# The Atmos CLI the Atmos demo's workflow runs, checked against the release's SHA256SUMS.
# 1.233 or later: `deploy --affected --ci` verifies each component's stored plan
# (components.terraform.planfiles), which the demo's merge job applies.
FROM fetch AS atmos
ARG TARGETARCH
ARG ATMOS_VERSION=1.233.2
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
# chant's `terraform report` (INTENTIUS/chant#4420), which the workflows of the
# Terragrunt and Atmos demos run after a plan and an apply to write what behold
# reads. chant core is the published CHANT_VERSION, and so is the terraform
# lexicon unless CHANT_REF names a commit of INTENTIUS/chant to pack it from
# instead, for a report change no release carries yet. Nothing is published. It sits under
# /opt/chant-report with its own chant.config.json (chant finds a lexicon's
# verbs through a project's config), and chant-report runs from there, so the
# wave's chant on PATH stays the tofu image's.
#
# It is built on the node image the tofu CI image is built on (the digest in
# images/Dockerfile.tofu), not on BASE itself: BASE carries terragucci's bundle,
# which changes with nearly every terragucci commit, and a stage FROM it would
# fetch and install chant again each time although CHANT_VERSION and CHANT_REF
# did not move. npm's download cache is a BuildKit cache mount.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS chant-report
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG CHANT_VERSION
ARG CHANT_REF
RUN --mount=type=cache,target=/root/.npm \
  set -e; \
  [ -n "${CHANT_VERSION:-}" ] || { echo "pass --build-arg CHANT_VERSION" >&2; exit 1; }; \
  mkdir -p /src /opt/chant-report; cd /src; \
  if [ -n "${CHANT_REF:-}" ]; then \
    git init -q; git remote add origin https://github.com/INTENTIUS/chant.git; \
    git fetch -q --depth 1 origin "$CHANT_REF"; git checkout -q FETCH_HEAD; \
    npm ci --ignore-scripts --no-audit --no-fund; \
    (cd lexicons/terraform && npm pack --pack-destination /opt/chant-report >/dev/null); \
  else \
    npm pack --pack-destination /opt/chant-report "@intentius/chant-lexicon-terraform@${CHANT_VERSION}" >/dev/null; \
  fi; \
  cd /opt/chant-report; \
  printf '{"name":"chant-report","private":true}\n' > package.json; \
  printf '{"lexicons":["terraform"]}\n' > chant.config.json; \
  npm install --no-audit --no-fund "@intentius/chant@${CHANT_VERSION}" ./intentius-chant-lexicon-terraform-*.tgz; \
  rm -f ./*.tgz; rm -rf /src; \
  node_modules/.bin/chant terraform report 2>&1 | grep -q "^usage: chant terraform report"
FROM ${BASE}
COPY --from=yodel /opt/yodel /opt/yodel
COPY --from=chant-report /opt/chant-report /opt/chant-report
COPY --chmod=0755 chant-report /usr/local/bin/chant-report
COPY --from=choudoufu /out/choudoufu /usr/local/bin/choudoufu
COPY --from=atmos /out/atmos /usr/local/bin/atmos
COPY --from=awsprovider /providers /opt/terragucci-demo/providers
COPY tofu-mirror.tfrc /etc/terragucci-demo/tofu-mirror.tfrc
# The same file where the product repos' demo workflows (INTENTIUS/choudoufu examples/demo-*) look.
COPY tofu-mirror.tfrc /etc/demo/tofu-mirror.tfrc
ARG CHOUDOUFU_VERSION
LABEL org.opencontainers.image.title="terragucci-demo-tofu"
LABEL org.opencontainers.image.description="terragucci's tofu CI image with SQL Yodeler 0.9.0, choudoufu ${CHOUDOUFU_VERSION} and a hashicorp/aws mirror, for the demo's jobs"
