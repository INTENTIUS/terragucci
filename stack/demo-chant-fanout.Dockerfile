# The image the demo's fan-out repo runs its jobs in (stack/demo.sh,
# example-demo-chant-fanout/). stack/demo.sh up builds it into the local daemon
# as terragucci-demo-chant-fanout:local, where forgejo-runner (force_pull:
# false) finds it without pulling, so a job downloads nothing: terragucci's
# tofu image brings node and git, and this adds the chant CLI and its aws
# lexicon at the versions example-demo-chant-fanout/package-lock.json pins, and
# AWS CLI v2, which cfn-deploy runs. Build context: example-demo-chant-fanout/.
# BASE: the tofu image's reference (scripts/images.ts tags).
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
FROM ${BASE}
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
COPY package.json package-lock.json /opt/demo-chant-fanout/
# The stack's floci, for chant's cfn-deploy, the AWS CLI and --report-url's
# copies: the pipeline is chant's generated one, which names no endpoint.
ENV AWS_ENDPOINT_URL=http://floci:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
# chant loads its lexicons from beside itself, so both live in one prefix; a
# job links /opt/demo-chant-fanout/node_modules into its checkout, so the
# templates' imports of the aws lexicon resolve. The tofu image's
# /usr/local/bin/chant is the slim wave runtime; this one replaces it.
RUN ln -sf /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws \
  && cd /opt/demo-chant-fanout && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
  && ln -sf /opt/demo-chant-fanout/node_modules/.bin/chant /usr/local/bin/chant \
  && chant --version && aws --version && git --version
LABEL org.opencontainers.image.title="terragucci-demo-chant-fanout"
LABEL org.opencontainers.image.description="terragucci's tofu image with the chant CLI, its aws lexicon and AWS CLI v2, for the demo's fan-out repo"
