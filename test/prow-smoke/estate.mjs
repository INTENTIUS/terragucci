// The Prow smoke test's estate: a copy of example/ that keeps its roots,
// waves and module but needs no cloud and no network backend.
//
//   node test/prow-smoke/estate.mjs <example dir> <out dir> <fake GitHub base URL> <image>
//
// Each root's S3 backend becomes the local backend, each platform output
// read becomes a local terraform_remote_state with defaults, and the AWS
// resources become terraform_data, which OpenTofu keeps without a provider
// to download. The copy gets terragucci.yml for runtime: prow, with the
// GitHub API and server pointed at the fake GitHub inside the cluster and
// the jobs' image set to the one the scratch cluster holds.
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [example, out, fakeGitHub, image] = process.argv.slice(2);
if (!example || !out || !fakeGitHub || !image) {
  console.error("usage: node estate.mjs <example dir> <out dir> <fake GitHub base URL> <image>");
  process.exit(2);
}

// What the copy leaves behind: the forge's workflows and Ops (init writes the Prow jobs instead) and the AWS lock files.
const skip = (rel) => rel === ".forgejo" || rel === "ops" || rel === "changes" || rel.endsWith(".terraform.lock.hcl");
mkdirSync(out, { recursive: true });
cpSync(example, out, { recursive: true, filter: (src) => !skip(relative(example, src)) });

const replaceOnce = (text, from, to, file) => {
  const next = text.replace(from, to);
  if (next === text) throw new Error(`${file}: the estate copy expected ${from} and did not find it`);
  return next;
};

const block = (name) => new RegExp(`\\n${name} \\{\\n(?:.*\\n)*?\\}\\n`);
const nested = (name) => new RegExp(`\\n  ${name} \\{\\n(?:.*\\n)*?  \\}\\n`);

for (const env of readdirSync(join(out, "envs"))) {
  for (const root of readdirSync(join(out, "envs", env))) {
    const file = join(out, "envs", env, root, "main.tf");
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    let tf = readFileSync(file, "utf-8");
    tf = replaceOnce(tf, nested("required_providers"), "\n", file);
    tf = replaceOnce(tf, nested('backend "s3"'), '\n  # The smoke test keeps state in the job\'s checkout: no network backend.\n  backend "local" {}\n', file);
    tf = replaceOnce(tf, block('provider "aws"'), "\n", file);
    if (root === "platform") {
      tf = replaceOnce(tf, /resource "aws_s3_bucket" "logs" \{\n\s*bucket = ("[^"]+")\n\}/, 'resource "terraform_data" "logs" {\n  input = $1\n}', file);
      tf = replaceOnce(tf, "aws_s3_bucket.logs.bucket", "terraform_data.logs.output", file);
    } else {
      tf = replaceOnce(
        tf,
        /data "terraform_remote_state" "platform" \{\n(?:.*\n)*?\}\n/,
        `data "terraform_remote_state" "platform" {\n  backend = "local"\n  config = {\n    path = "../platform/terraform.tfstate"\n  }\n  # Before the platform root has applied in this checkout, its output is the bucket it will name.\n  defaults = {\n    logs_bucket = "shop-${env}-logs"\n  }\n}\n`,
        file,
      );
    }
    writeFileSync(file, tf.replace(/\n{3,}/g, "\n\n"));
  }
}

// The service module with terraform_data in place of the bucket, queues and table, and the same inputs and outputs.
const moduleFile = join(out, "modules/service/main.tf");
const mod = readFileSync(moduleFile, "utf-8");
const variables = mod.match(/variable "[^"]+" \{\n(?:.*\n)*?\}\n/g);
for (const v of ["env", "name", "logs_bucket", "job_retention_seconds", "records_key", "records_table", "dead_letter_queue"]) {
  if (!variables?.some((d) => d.startsWith(`variable "${v}"`))) throw new Error(`${moduleFile}: the estate copy expected variable ${v}`);
}
writeFileSync(
  moduleFile,
  `# One service, as example/modules/service has it, with terraform_data in place
# of the AWS resources: the Prow smoke test plans and applies it with no
# provider and no cloud.

${variables.join("\n")}
locals {
  prefix = "shop-\${var.env}-\${var.name}"
}

resource "terraform_data" "files" {
  input = "\${local.prefix}-files"
}

resource "terraform_data" "dead_letter" {
  count = var.dead_letter_queue ? 1 : 0
  input = "\${local.prefix}-dead-letter"
}

resource "terraform_data" "jobs" {
  input = {
    name      = "\${local.prefix}-jobs"
    retention = var.job_retention_seconds
  }
}

resource "terraform_data" "records" {
  count = var.records_table ? 1 : 0
  input = {
    name = "\${local.prefix}-records"
    key  = var.records_key
  }
}

resource "terraform_data" "registration" {
  input = {
    bucket  = var.logs_bucket
    key     = "services/\${var.name}.json"
    service = var.name
  }
}

output "jobs_queue" {
  value = terraform_data.jobs.output.name
}

output "records_table" {
  value = one(terraform_data.records[*].output.name)
}
`,
);

const base = fakeGitHub.replace(/\/+$/, "");
writeFileSync(
  join(out, "terragucci.yml"),
  `binary: tofu
runtime: prow
forge: github
approval: prow-labels
waves:
  canary: ["envs/dev/*"]
drift: "0 6 * * *"
# The image the smoke test built or pinned, which the scratch cluster holds.
image: ${image}
# The jobs talk to the fake GitHub inside the scratch cluster, never to github.com.
env:
  GITHUB_API_URL: ${base}/api/v3
  GITHUB_SERVER_URL: ${base}
prow:
  cluster: default
  trusted_cluster: trusted
  namespace: test-pods
  service_accounts: { plan: tf-plan, apply: tf-apply }
  token_secret: { name: terragucci-github-token }
  plan_before_merge: true
`,
);
console.log(out);
