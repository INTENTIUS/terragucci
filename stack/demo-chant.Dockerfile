# The image the demo's chant repo runs its jobs in (stack/demo.sh, example-demo-chant/).
# stack/demo.sh up builds it into the local daemon as terragucci-demo-chant:local,
# where forgejo-runner (force_pull: false) finds it without pulling, so a job
# downloads no OpenTofu and no chant: terragucci's tofu image brings node, git
# and OpenTofu, and this adds the full chant CLI and its terraform lexicon at
# the versions example-demo-chant/package-lock.json pins. Build context:
# example-demo-chant/. BASE: the tofu image's reference (scripts/images.ts tags).
ARG BASE
FROM ${BASE}
COPY package.json package-lock.json /opt/demo-chant/
# chant loads its lexicons from beside itself, so both live in one prefix. The
# tofu image's /usr/local/bin/chant is the slim wave runtime; this one replaces it.
RUN cd /opt/demo-chant && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
  && ln -sf /opt/demo-chant/node_modules/.bin/chant /usr/local/bin/chant \
  && chant --version && tofu version && git --version
LABEL org.opencontainers.image.title="terragucci-demo-chant"
LABEL org.opencontainers.image.description="terragucci's tofu image with the chant CLI and its terraform lexicon, for the demo's chant repo"
