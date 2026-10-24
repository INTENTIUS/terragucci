# The image the demo's Terragrunt-on-choudoufu repo runs its jobs in
# (stack/demo.sh, example-demo-terragrunt-choudoufu/). stack/demo.sh up builds
# it into the local daemon as terragucci-demo-terragrunt-choudoufu:local.
#
#   CHOUDOUFU_IMAGE   the demo's choudoufu image (terragucci-demo-choudoufu:local):
#                     choudoufu, node, git, and the hashicorp/aws mirror
#   TERRAGRUNT_IMAGE  terragucci's Terragrunt image (scripts/images.ts tags),
#                     which the terragrunt binary is taken from
#
# Nothing else is added but jq and curl, which the workflow's comment and review
# steps call.
ARG CHOUDOUFU_IMAGE
ARG TERRAGRUNT_IMAGE
FROM ${TERRAGRUNT_IMAGE} AS terragrunt
FROM ${CHOUDOUFU_IMAGE}
COPY --from=terragrunt /usr/local/bin/terragrunt /usr/local/bin/terragrunt
USER root
RUN set -e; for t in jq curl; do command -v $t >/dev/null || { \
    if command -v apk >/dev/null; then apk add --no-cache $t; else apt-get update && apt-get install -y --no-install-recommends $t && rm -rf /var/lib/apt/lists/*; fi; }; done; \
  terragrunt --version && choudoufu version
LABEL org.opencontainers.image.title="terragucci-demo-terragrunt-choudoufu"
