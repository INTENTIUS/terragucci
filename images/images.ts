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
import { DECIDE_IMAGE, LAYA_MODEL, TOOL_VERSIONS } from "../packages/terragucci/src/images";

/** Base images by index digest, so a rebuild cannot change underneath a tag. */
const NODE = "node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c";
const DEBIAN = "debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";
const PYTHON = "python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3";

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

/**
 * terragucci-decide (terragucci#29): the opt-in decision service. Not a CI
 * image: `just images` and `just images-check` leave it out, it has no entry in
 * images/budget.json, and no pipeline runs in it. `just decide-image` builds it.
 *
 * The build stage installs the CPU build of torch and `laya[serve]` into a
 * virtualenv and downloads the checkpoint at its pinned Hub commit, checking
 * the weights' SHA-256. The final stage carries the virtualenv, the weights
 * and images/decide/server.py, runs as an unprivileged user, and never reaches
 * the Hub: it serves one preloaded checkpoint on CPU at port 8790.
 */
const ckpt = DECIDE_IMAGE.checkpoint;
const snapshot = `/opt/hf/hub/models--${ckpt.repo.replace("/", "--")}/snapshots/${ckpt.revision}`;
const download =
  `HF_HOME=/opt/hf /opt/venv/bin/python -c 'from huggingface_hub import snapshot_download; ` +
  `snapshot_download("${ckpt.repo}", revision="${ckpt.revision}", ` +
  `allow_patterns=["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"])' && ` +
  `echo "${ckpt.weightsSha256}  ${snapshot}/model.safetensors" | sha256sum -c -`;

export const decide = new Dockerfile({
  stages: [
    {
      from: PYTHON,
      as: "build",
      env: ["PIP_NO_CACHE_DIR=1", "PIP_DISABLE_PIP_VERSION_CHECK=1"],
      run: [
        "python -m venv --upgrade-deps /opt/venv",
        `/opt/venv/bin/pip install "torch==${DECIDE_IMAGE.torch}" --index-url https://download.pytorch.org/whl/cpu`,
        `/opt/venv/bin/pip install "laya[serve]==${DECIDE_IMAGE.laya}" && /opt/venv/bin/pip check`,
        download,
      ],
    },
    {
      from: PYTHON,
      env: [
        'PATH="/opt/venv/bin:$PATH"',
        "HOME=/tmp",
        "PYTHONUNBUFFERED=1",
        "PYTHONDONTWRITEBYTECODE=1",
        "HF_HOME=/opt/hf",
        "HF_HUB_OFFLINE=1",
        "USE_TF=0",
        "TOKENIZERS_PARALLELISM=false",
        "TORCH_DISABLE_NATIVE_JIT=1",
        "OMP_NUM_THREADS=4",
        "LAYA_THREADS=4",
        "LAYA_DEVICE=cpu",
        `LAYA_MODELS=${ckpt.name}`,
        "LAYA_PRELOAD=1",
        `LAYA_REVISION=${ckpt.revision}`,
        `LAYA_SHA256_DIGESTS='{"model.safetensors":"${ckpt.weightsSha256}"}'`,
        `DECIDE_MODEL=${LAYA_MODEL}`,
        `DECIDE_CHECKPOINT=${ckpt.name}`,
        `DECIDE_PORT=${DECIDE_IMAGE.port}`,
      ],
      user: "10001:10001",
      copy: [
        "--from=build /opt/venv /opt/venv",
        "--from=build --chown=10001:10001 /opt/hf /opt/hf",
        "images/decide/server.py /opt/decide/server.py",
      ],
      expose: [`${DECIDE_IMAGE.port}`],
      label: [
        'org.opencontainers.image.title="terragucci-decide"',
        `org.opencontainers.image.description="Laya ${DECIDE_IMAGE.laya} (${ckpt.repo}@${ckpt.revision.slice(0, 12)}) on CPU behind the Jev /v1/systemone shape"`,
        `org.opencontainers.image.version="${pkg.version}"`,
        'org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"',
        'org.opencontainers.image.licenses="Apache-2.0"',
      ],
      cmd: '["python", "/opt/decide/server.py"]',
      healthcheck: `--interval=10s --timeout=5s --start-period=5m --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${DECIDE_IMAGE.port}/health', timeout=4)"]`,
    },
  ],
});
