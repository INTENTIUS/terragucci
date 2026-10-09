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

/**
 * Base images by index digest, so a rebuild cannot change underneath a tag.
 * NODE carries Node 22.23.3; CDK Terrain's cdktn 0.24, which a `synth` job
 * runs on the image, needs 22.19 or later.
 */
const NODE = "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
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

/** choudoufu's SHA256SUMS names each file as ./<file>, which sha256sum -c reads as is from /tmp. */
const choudoufuFetch = (v: string): string => {
  const base = `https://github.com/INTENTIUS/choudoufu/releases/download/v${v}`;
  const file = `choudoufu_v${v}_linux_$a.tar.gz`;
  return [
    'case "$TARGETARCH" in arm64) a=arm64 ;; *) a=amd64 ;; esac',
    `curl -fsSLo "/tmp/${file}" "${base}/${file}" && curl -fsSLo /tmp/SHA256SUMS "${base}/SHA256SUMS" && ` +
      `(cd /tmp && grep "  \\./${file}$" SHA256SUMS | sha256sum -c -)`,
    `mkdir -p /out && tar -xzf "/tmp/${file}" -C /out choudoufu`,
  ].join(" && ");
};

const finalStage = (name: string, description: string) => ({
  from: NODE,
  // A forge may run the job as a uid with no /etc/passwd entry. Go reads the user
  // from the passwd file, or without cgo from $USER and $HOME, and tofu with an
  // OTLP endpoint set fails ("Current requires cgo or $USER set") when it finds
  // neither. These defaults hold for any uid and any entrypoint; a forge that sets
  // its own USER or HOME wins, and /tmp is writable for every uid.
  env: ["USER=terragucci", "HOME=/tmp"],
  run: [
    "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
    // A job often runs as another user than the one who owns its checkout (on
    // github.com the job is root and the runner's user owns the workspace), and
    // git then refuses every command there ("dubious ownership"). The system
    // config holds for every user and HOME, in every job and in workflows that
    // are not terragucci's, and for the upload-pack a fetch from a local path
    // starts, which drops GIT_CONFIG_* from its environment. Debian's git 2.39
    // matches no path prefix, so it is every directory.
    "git config --system --add safe.directory '*'",
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

export const choudoufu = new Dockerfile({
  stages: [
    { from: DEBIAN, as: "fetch", arg: ["TARGETARCH"], run: [fetchTools, choudoufuFetch(TOOL_VERSIONS.choudoufu)] },
    finalStage("choudoufu", `choudoufu ${TOOL_VERSIONS.choudoufu} and the terragucci engine`),
  ],
});

/**
 * terragucci-decide (terragucci#29): the opt-in decision service. Not a CI
 * image: `just images` and `just images-check` leave it out, it has no entry in
 * images/budget.json, and no pipeline runs in it. `just decide-image` builds it.
 *
 * The build stage installs images/decide/requirements.txt (the CPU build of
 * torch, `laya[serve]` and everything they need, each wheel pinned by its
 * sha256, `pip install --require-hashes`) into a virtualenv and downloads the checkpoint at its pinned Hub commit, checking
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
      // Every wheel, torch and laya included, comes from the hash-locked file: nothing resolves at build time.
      run: [
        // The venv keeps the pip the pinned base image ships; the lock file then installs the pinned one.
        "python -m venv /opt/venv",
        "--mount=type=bind,source=images/decide/requirements.txt,target=/tmp/requirements.txt /opt/venv/bin/pip install --require-hashes --no-deps --only-binary=:all: --extra-index-url https://download.pytorch.org/whl/cpu -r /tmp/requirements.txt && /opt/venv/bin/pip check",
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
        "--chmod=0755 images/decide/server.py /opt/decide/server.py",
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
