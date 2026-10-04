/**
 * terragucci's CI images, one per toolchain (terragucci#19), declared rather than
 * hand-written. `just ci` renders each into images/Dockerfile.<name>, and
 * `just ci-check` fails when a rendered file differs from this declaration.
 *
 * Every image builds in two stages. The fetch stage downloads each binary and
 * checks it against the release's SHA256SUMS, so curl never reaches the final
 * image. The final stage is node:22-bookworm-slim with git and CA certificates,
 * the binaries, and the terragucci bundle (packages/terragucci/dist, built by
 * `just build-cli` first). Tool versions come from the package itself, so an
 * image and the pipelines `init` writes for it always agree.
 */
import { Dockerfile } from "@intentius/chant-lexicon-docker";
import pkg from "../packages/terragucci/package.json" with { type: "json" };
import { TOOL_VERSIONS } from "../packages/terragucci/src/images";

/** Base images by index digest, so a rebuild cannot change underneath a tag. */
const NODE = "node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c";
const DEBIAN = "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const fetchTools = "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*";

/** Shell that downloads one release asset and its SHA256SUMS, and checks it. */
const verified = (url: string, sums: string, file: string): string =>
  `curl -fsSLo "/tmp/${file}" "${url}" && curl -fsSLo /tmp/SHA256SUMS "${sums}" && ` +
  `(cd /tmp && grep " \\*\\?${file}$" SHA256SUMS | sed 's/ \\*/  /' | sha256sum -c -)`;

const tofuFetch = (v: string): string =>
  [
    'case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac',
    verified(
      `https://github.com/opentofu/opentofu/releases/download/v${v}/tofu_${v}_linux_$a.tar.gz`,
      `https://github.com/opentofu/opentofu/releases/download/v${v}/tofu_${v}_SHA256SUMS`,
      `tofu_${v}_linux_$a.tar.gz`,
    ),
    `mkdir -p /out && tar -xzf "/tmp/tofu_${v}_linux_$a.tar.gz" -C /out tofu`,
  ].join(" && ");

const terraformFetch = (v: string): string =>
  [
    'case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac',
    verified(
      `https://releases.hashicorp.com/terraform/${v}/terraform_${v}_linux_$a.zip`,
      `https://releases.hashicorp.com/terraform/${v}/terraform_${v}_SHA256SUMS`,
      `terraform_${v}_linux_$a.zip`,
    ),
    `mkdir -p /out && unzip -q "/tmp/terraform_${v}_linux_$a.zip" terraform -d /out`,
  ].join(" && ");

const terragruntFetch = (v: string): string =>
  [
    'case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac',
    verified(
      `https://github.com/gruntwork-io/terragrunt/releases/download/v${v}/terragrunt_linux_$a`,
      `https://github.com/gruntwork-io/terragrunt/releases/download/v${v}/SHA256SUMS`,
      `terragrunt_linux_$a`,
    ),
    `mkdir -p /out && install -m 0755 "/tmp/terragrunt_linux_$a" /out/terragrunt`,
  ].join(" && ");

const finalStage = (name: string, description: string) => ({
  from: NODE,
  run: [
    "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
    // The HCL parser the tips and rollouts read with. /usr/local/node_modules is on the
    // bundle's module path, so `terragucci` finds it with no further setup.
    `npm install --prefix /usr/local --no-save --omit=dev --no-audit --no-fund @cdktn/hcl2json@${pkg.devDependencies["@cdktn/hcl2json"]} && npm cache clean --force`,
  ],
  copy: [
    "--from=fetch /out/ /usr/local/bin/",
    "--chmod=0755 packages/terragucci/dist/terragucci.mjs /usr/local/bin/terragucci",
  ],
  label: [
    `org.opencontainers.image.title="terragucci-${name}"`,
    `org.opencontainers.image.description="${description}"`,
    `org.opencontainers.image.version="${pkg.version}"`,
    'org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"',
    'org.opencontainers.image.licenses="Apache-2.0"',
  ],
  cmd: '["bash"]',
});

export const tofu = new Dockerfile({
  stages: [
    { from: DEBIAN, as: "fetch", arg: ["TARGETARCH"], run: [fetchTools, tofuFetch(TOOL_VERSIONS.tofu)] },
    finalStage("tofu", `OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`),
  ],
});

export const terraform = new Dockerfile({
  stages: [
    { from: DEBIAN, as: "fetch", arg: ["TARGETARCH"], run: [fetchTools, terraformFetch(TOOL_VERSIONS.terraform)] },
    finalStage("terraform", `Terraform ${TOOL_VERSIONS.terraform} and the terragucci engine`),
  ],
});

export const terragrunt = new Dockerfile({
  stages: [
    {
      from: DEBIAN,
      as: "fetch",
      arg: ["TARGETARCH"],
      run: [fetchTools, tofuFetch(TOOL_VERSIONS.tofu), terragruntFetch(TOOL_VERSIONS.terragrunt)],
    },
    finalStage("terragrunt", `Terragrunt ${TOOL_VERSIONS.terragrunt}, OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`),
  ],
});
