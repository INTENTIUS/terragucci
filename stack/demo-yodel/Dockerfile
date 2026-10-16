# The demo's job image: terragucci's tofu CI image with SQL Yodeler beside it,
# so app's wave runs app/schema's migrations (example-demo/app/main.tf).
# stack/demo.sh up builds it as terragucci-demo-tofu:local, and
# example-demo/terragucci.yml names it as the image every job runs in.
#
#   BASE   the tofu CI image (scripts/images.ts tags)
#
# yodel, chant and the sql lexicon come from SQL Yodeler's own CI image, pinned
# by digest, under /opt/yodel. Nothing here puts them on PATH or in a
# node_modules terragucci resolves from: the wave's chant stays the tofu
# image's. The migration step puts /opt/yodel/node_modules/.bin on its own PATH
# and links /opt/yodel/node_modules into the project.
ARG BASE
FROM ghcr.io/intentius/sql-yodeler:0.9.0@sha256:15f7406fd59f2f74f4299de0fb6121c9905278276aac86dde993e2223eb97946 AS yodel
FROM ${BASE}
COPY --from=yodel /opt/yodel /opt/yodel
LABEL org.opencontainers.image.title="terragucci-demo-tofu"
LABEL org.opencontainers.image.description="terragucci's tofu CI image with SQL Yodeler 0.9.0, for the demo's jobs"
