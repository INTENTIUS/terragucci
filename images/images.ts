/**
 * terragucci's CI images, one per toolchain (terragucci#19), declared rather than
 * hand-written. `just ci` renders each into images/Dockerfile.<name>, and
 * `just ci-check` fails when a rendered file differs from this declaration.
 *
 * chant's productImageStages (chant issue 4784) writes each CI image: a fetch
 * stage that downloads every engine and checks it against its release's
 * checksums file and the sha256 chant records for it (CI_TOOL_SHA256), so curl never reaches the final image; then node:22-bookworm-slim
 * with git and CA certificates, the engines under /opt/terragucci linked onto
 * PATH, chant's wave runtime and the terragucci bundle
 * (packages/terragucci/dist, built by `just build-cli` first). Tool versions
 * come from the package itself, so an image and the pipelines `init` writes
 * for it always agree.
 */
import { CI_IMAGE_LABEL_ARG, productImageStages, type CiImageTool } from "@intentius/chant/ci-image";
import { Dockerfile } from "@intentius/chant-lexicon-docker";
import pkg from "../packages/terragucci/package.json" with { type: "json" };
import { DECIDE_IMAGE, LAYA_MODEL, TOOL_VERSIONS } from "../packages/terragucci/src/images";

/** The build argument a release passes its label in (chant's release.version): each image's version label reads it. */
export const RELEASE_LABEL_ARG = CI_IMAGE_LABEL_ARG;

/** Python by index digest, for the decide image, so a rebuild cannot change underneath a tag. */
const PYTHON = "python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3";

const engine = (tool: keyof typeof TOOL_VERSIONS): CiImageTool => ({ tool, version: TOOL_VERSIONS[tool] });

const ciImage = (name: string, description: string, tools: CiImageTool[]): Dockerfile =>
  new Dockerfile({
    stages: productImageStages({
      name: `terragucci-${name}`,
      product: "terragucci",
      description,
      source: "https://github.com/INTENTIUS/terragucci",
      tools,
      // The HCL parser the tips and rollouts read with. /usr/local/node_modules is on the
      // bundle's module path, so `terragucci` finds it with no further setup.
      npm: [`@cdktn/hcl2json@${pkg.devDependencies["@cdktn/hcl2json"]}`],
      // chant, whose bin a wave job runs (`chant run wave`) and approve and the relay record
      // through, as the release the package pins. No chant package is installed, so the bundle
      // finds this `chant` on the path.
      chant: pkg.dependencies["@intentius/chant"],
      bundle: { file: "packages/terragucci/dist/terragucci.mjs", bin: "terragucci" },
    }),
  });

export const tofu = ciImage("tofu", `OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`, [engine("tofu")]);

export const terraform = ciImage("terraform", `Terraform ${TOOL_VERSIONS.terraform} and the terragucci engine`, [engine("terraform")]);

export const terragrunt = ciImage(
  "terragrunt",
  `Terragrunt ${TOOL_VERSIONS.terragrunt}, OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`,
  [engine("tofu"), engine("terragrunt")],
);

export const choudoufu = ciImage("choudoufu", `choudoufu ${TOOL_VERSIONS.choudoufu} and the terragucci engine`, [engine("choudoufu")]);

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
      arg: [RELEASE_LABEL_ARG],
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
        `org.opencontainers.image.version="\${${RELEASE_LABEL_ARG}}"`,
        'org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"',
        'org.opencontainers.image.licenses="Apache-2.0"',
      ],
      cmd: '["python", "/opt/decide/server.py"]',
      healthcheck: `--interval=10s --timeout=5s --start-period=5m --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${DECIDE_IMAGE.port}/health', timeout=4)"]`,
    },
  ],
});
