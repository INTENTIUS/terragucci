# The fountain steward's machine: a fountain runner whose sandboxes can run
# the example's apply. stack/bootstrap.sh builds it as
# terragucci-fountain-steward:local on top of terragucci's tofu CI image, so a
# steward turn has the same tofu and terragucci a forge job has. It is also the
# image of the forge job that hands tf-apply to the steward
# (stack/steward.sh), since that job needs chant and its fountain lexicon too.
#
#   BASE              the tofu CI image (scripts/images.ts tags)
#   FOUNTAIN_VERSION  the fountain release whose CLI runs `fountain runner`;
#                     the same version as the fountain server in docker-compose.yml
#   CHANT_VERSION     @intentius/chant and @intentius/chant-lexicon-fountain,
#                     the version terragucci's package.json pins
#
# The sandboxes are directories in this container (fountain's process backend,
# trusted mode). A turn spawns `chant acp` in one of them, and chant resolves
# the Op files there against the global node_modules, which steward.sh links in.
ARG BASE
FROM ${BASE}
ARG FOUNTAIN_VERSION
ARG CHANT_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN a="$(dpkg --print-architecture)" && case "$a" in amd64|arm64) ;; *) echo "no fountain CLI for $a" >&2; exit 1 ;; esac \
 && curl -fsSLo /usr/local/bin/fountain "https://github.com/managoat/fountain/releases/download/${FOUNTAIN_VERSION}/fountain-linux-$a" \
 && chmod 0755 /usr/local/bin/fountain
RUN npm install -g --no-audit --no-fund \
      "@intentius/chant@${CHANT_VERSION}" "@intentius/chant-lexicon-fountain@${CHANT_VERSION}" \
      typescript@5.9.3 zod@4 \
 && npm cache clean --force && chant --version
RUN mkdir -p /sandboxes
WORKDIR /sandboxes
