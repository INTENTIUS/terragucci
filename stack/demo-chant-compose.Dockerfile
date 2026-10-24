# The image the demo's chant compose repo runs its jobs in (stack/demo.sh,
# example-demo-chant-compose/). stack/demo.sh up builds it into the local
# daemon as terragucci-demo-chant-compose:local, where forgejo-runner
# (force_pull: false) finds it without pulling, so a job downloads nothing:
# terragucci's tofu image brings node and git, and this adds the chant CLI and
# its aws lexicon, and AWS CLI v2, which cfn-deploy runs. Build context:
# example-demo-chant-compose/ (not read: the packages come from chant).
# BASE: the tofu image's reference (scripts/images.ts tags).
# CHANT_REF: the commit of INTENTIUS/chant the packages are built from. One
# approval covers a composed run's re-plan (chant#4422, #4423, #4430) only on
# chant main, in no release yet, so core and the aws lexicon are packed from
# the commit with `npm pack`, as the release workflow packs them. The jobs
# run the CLI and the lexicon as any project installs them from npm.
#
# The AWS CLI is the release terragucci's drift job installs, checked against
# the same sha256 (AWS_CLI in packages/terragucci/src/render.ts;
# test/demo-sh.test.ts holds the two to one version).
ARG BASE
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS awscli
ARG TARGETARCH
ARG AWS_CLI_VERSION=2.37.9
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && apt-get clean
RUN set -e; case "$TARGETARCH" in \
    arm64) a=aarch64; sum=e7d2cca3622af4765871fe9ce7eeed03acd09dca10a99ebc46e92f79d78765c0 ;; \
    *) a=x86_64; sum=6b3a6a3d7bb3997928f0bdf7b866914224abf242c2e54e1dcebbe84bee64f356 ;; \
  esac; \
  curl -fsSLo /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-$a-${AWS_CLI_VERSION}.zip"; \
  echo "$sum  /tmp/awscliv2.zip" | sha256sum -c -; \
  unzip -q /tmp/awscliv2.zip -d /tmp; \
  /tmp/aws/install --install-dir /usr/local/aws-cli --bin-dir /tmp/aws-bin

FROM ${BASE} AS chant-packs
ARG CHANT_REF
RUN set -e; \
  [ -n "${CHANT_REF:-}" ] || { echo "pass --build-arg CHANT_REF" >&2; exit 1; }; \
  mkdir -p /src /packs; cd /src; \
  git init -q; git remote add origin https://github.com/INTENTIUS/chant.git; \
  git fetch -q --depth 1 origin "$CHANT_REF"; git checkout -q FETCH_HEAD; \
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null; \
  npm rebuild esbuild >/dev/null; \
  (cd packages/core && npm pack --pack-destination /packs >/dev/null); \
  (cd lexicons/aws && npm pack --pack-destination /packs >/dev/null); \
  ls /packs

FROM ${BASE}
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
COPY --from=chant-packs /packs /opt/chant-packs
# The stack's floci, for chant's cfn-deploy, the AWS CLI and --report-url's
# copies: the pipeline is chant's generated one, which names no endpoint.
ENV AWS_ENDPOINT_URL=http://floci:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
# chant loads its lexicons from beside itself, so both live in one prefix; a
# job links /opt/demo-chant-compose/node_modules into its checkout, so the
# templates' imports of the aws lexicon resolve. The tofu image's
# /usr/local/bin/chant is the slim wave runtime; this one replaces it.
RUN ln -sf /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws \
  && mkdir -p /opt/demo-chant-compose && cd /opt/demo-chant-compose \
  && printf '{"name":"demo-chant-compose-image","private":true,"type":"module"}\n' > package.json \
  && npm install --omit=dev --no-audit --no-fund /opt/chant-packs/*.tgz && npm cache clean --force \
  && ln -sf /opt/demo-chant-compose/node_modules/.bin/chant /usr/local/bin/chant \
  && chant --version && aws --version && git --version
LABEL org.opencontainers.image.title="terragucci-demo-chant-compose"
LABEL org.opencontainers.image.description="terragucci's tofu image with the chant CLI, its aws lexicon (from a chant commit) and AWS CLI v2, for the demo's compose repo"
