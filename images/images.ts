/**
 * terragucci's CI images, one per toolchain (terragucci#19) and in two sets, declared rather than
 * hand-written. `just ci` renders each into images/Dockerfile.<name>, and
 * `just ci-check` fails when a rendered file differs from this declaration.
 *
 * chant's productImageStages (chant issue 4784) writes each CI image: a fetch
 * stage that downloads every engine and checks it against its release's
 * checksums file and the sha256 chant records for it (CI_TOOL_SHA256), so curl never reaches the final image; then the
 * final stage with git and CA certificates, the engines under /opt/terragucci linked onto
 * PATH, chant's wave runtime and the terragucci bundle
 * (packages/terragucci/dist, built by `just build-cli` first). Tool versions
 * come from the package itself, so an image and the pipelines `init` writes
 * for it always agree.
 *
 * The two sets differ in their base, which `base` in productImageStages picks:
 *   Debian (the default, Dockerfile.<name>): node:22-bookworm-slim and debian:bookworm-slim by digest, apt, Node 22,
 *     and the final user is root.
 *   Chainguard (Dockerfile.<name>Chainguard, released as <name>-chainguard): cgr.dev/chainguard/node:latest-dev and
 *     wolfi-base by digest, apk, the Node that Wolfi packages (not 22), and the final user is 65532.
 * A release builds both sets and records both sets' digests in the bundle; `image.base` in terragucci.yml picks the
 * set a repo's pipeline runs in. This file declares the Debian set and terragucci-decide, images/chainguard.ts the
 * Chainguard set, and images/stages.ts what they share. The Chainguard set needs a chant that carries
 * CI_IMAGE_BASE_FLOOR, and loading chainguard.ts throws on an older one.
 */
import { CI_IMAGE_LABEL_ARG } from "@intentius/chant/ci-image";
import { Dockerfile } from "@intentius/chant-lexicon-docker";
import { DECIDE_IMAGE, LAYA_MODEL, TOOL_VERSIONS } from "../packages/terragucci/src/images";
import { ciStages, ENGINES } from "./stages";

/** The build argument a release passes its label in (chant's release.version): each image's version label reads it. */
export const RELEASE_LABEL_ARG = CI_IMAGE_LABEL_ARG;

/** Python by index digest, for the decide image, so a rebuild cannot change underneath a tag. */
const PYTHON = "python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3";

const tofuStages = ciStages("tofu", `OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`, [ENGINES.tofu], "debian");
const terraformStages = ciStages("terraform", `Terraform ${TOOL_VERSIONS.terraform} and the terragucci engine`, [ENGINES.terraform], "debian");
const terragruntStages = ciStages(
  "terragrunt",
  `Terragrunt ${TOOL_VERSIONS.terragrunt}, OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`,
  [ENGINES.tofu, ENGINES.terragrunt],
  "debian",
);
const choudoufuStages = ciStages("choudoufu", `choudoufu ${TOOL_VERSIONS.choudoufu} and the terragucci engine`, [ENGINES.choudoufu], "debian");

export const tofu = new Dockerfile({ stages: tofuStages });

export const terraform = new Dockerfile({ stages: terraformStages });

export const terragrunt = new Dockerfile({ stages: terragruntStages });

export const choudoufu = new Dockerfile({ stages: choudoufuStages });

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
      arg: [RELEASE_LABEL_ARG],
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
        `org.opencontainers.image.version="\${${RELEASE_LABEL_ARG}}"`,
        'org.opencontainers.image.source="https://github.com/INTENTIUS/terragucci"',
        'org.opencontainers.image.licenses="Apache-2.0"',
      ],
      cmd: '["python", "/opt/decide/server.py"]',
      healthcheck: `--interval=10s --timeout=5s --start-period=5m --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${DECIDE_IMAGE.port}/health', timeout=4)"]`,
    },
  ],
});
