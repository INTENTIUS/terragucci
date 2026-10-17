# The demo's job image: terragucci's tofu CI image with SQL Yodeler and
# choudoufu beside it, so app's wave runs app/schema's migrations
# (example-demo/app/main.tf) and the terralith's roots run on choudoufu
# (example-demo-terralith/terragucci.yml). stack/demo.sh up builds it as
# terragucci-demo-tofu:local, and both trees' terragucci.yml name it as the
# image every job runs in.
#
#   BASE                the tofu CI image (scripts/images.ts tags)
#   CHOUDOUFU_VERSION   the choudoufu release (stack/demo.sh's CHOUDOUFU_VERSION)
#
# yodel, chant and the sql lexicon come from SQL Yodeler's own CI image, pinned
# by digest, under /opt/yodel. Nothing here puts them on PATH or in a
# node_modules terragucci resolves from: the wave's chant stays the tofu
# image's. The migration step puts /opt/yodel/node_modules/.bin on its own PATH
# and links /opt/yodel/node_modules into the project.
#
# choudoufu comes from its GitHub release, checked against the sha256 that
# choudoufu.sha256 records for the version and arch, and goes to
# /usr/local/bin/choudoufu.
ARG BASE
FROM ghcr.io/intentius/sql-yodeler:0.9.0@sha256:15f7406fd59f2f74f4299de0fb6121c9905278276aac86dde993e2223eb97946 AS yodel
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS choudoufu
ARG TARGETARCH
ARG CHOUDOUFU_VERSION
COPY choudoufu.sha256 /tmp/choudoufu.sha256
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -e; case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac; \
  v="${CHOUDOUFU_VERSION:?pass --build-arg CHOUDOUFU_VERSION}"; f="choudoufu_v${v}_linux_${a}.tar.gz"; \
  sum="$(awk -v v="$v" -v a="$a" '$1 == v && $2 == a { print $3 }' /tmp/choudoufu.sha256)"; \
  [ -n "$sum" ] || { echo "choudoufu.sha256 records no sha256 for choudoufu $v on $a" >&2; exit 1; }; \
  curl -fsSLo "/tmp/$f" "https://github.com/INTENTIUS/choudoufu/releases/download/v${v}/$f"; \
  echo "$sum  /tmp/$f" | sha256sum -c -; \
  mkdir -p /out && tar -xzf "/tmp/$f" -C /out choudoufu
FROM ${BASE}
COPY --from=yodel /opt/yodel /opt/yodel
COPY --from=choudoufu /out/choudoufu /usr/local/bin/choudoufu
ARG CHOUDOUFU_VERSION
LABEL org.opencontainers.image.title="terragucci-demo-tofu"
LABEL org.opencontainers.image.description="terragucci's tofu CI image with SQL Yodeler 0.9.0 and choudoufu ${CHOUDOUFU_VERSION}, for the demo's jobs"
