#!/usr/bin/env python3
"""Regenerate example/changes/*.patch and example-terragrunt/changes/*.patch
from the examples as committed.

Each scenario is an edit described here, applied to a clean copy of example/
and saved as a git diff, so the patches always apply to the example's main.
Run it after changing anything under either example's units, roots or modules.
"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLE = os.path.join(HERE, "..", "example")
OUT = os.path.join(EXAMPLE, "changes")
L = "  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket\n"

SCENARIOS = {
    "one-root": [("envs/dev/orders/main.tf", L, L + "\n  # Orders in dev keeps unclaimed jobs for seven days instead of four.\n  job_retention_seconds = 604800\n", 1)],
    "module-bump": [("modules/service/main.tf", "visibility_timeout_seconds = 30", "visibility_timeout_seconds = 60", 2)],
    "replace": [("envs/prod/search/main.tf", L, L + '\n  # Search records are looked up by product, so key the table by sku.\n  records_key = "sku"\n', 1)],
    "destroy": [("envs/staging/email/main.tf", L, L + "\n  # Email in staging no longer keeps records.\n  records_table = false\n", 1)],
    "float": [("envs/dev/search/main.tf", '      version = "6.67.0"', '      version = "~> 6.0"', 1)],
    # A new file that `tofu fmt` would rewrite: the check stage must name it.
    "unformatted": [("envs/dev/orders/locals.tf", None, 'locals {\n    team   = "orders"\n  owner = "shop"\n}\n', 0)],
}

# An edit that runs `terragucci init` in the changed tree, as a person adding units would.
INIT = ("init", None, None, -1)
BUNDLE = os.path.join(HERE, "..", "packages", "terragucci", "dist", "terragucci.mjs")

J = "  job_retention_seconds = local.common.locals.job_retention_seconds\n"
R = "  logs_bucket           = dependency.platform.outputs.logs_bucket\n"
LEDGER = """include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  common = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  env    = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

# Where billing keeps its ledgers: a bucket of its own, made by the platform module.
terraform {
  source = "../../../modules/platform"
}

inputs = {
  shop = local.common.locals.shop
  env  = local.env.locals.env
  name = "ledger"
}
"""
BILLING = """include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  common = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  env    = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "../../../modules/service"
}

# Billing registers itself in the ledger bucket, which this same change adds.
# Until ledger applies it has no outputs, and Terragrunt would hand billing the
# mock. With no allow-list, that includes apply.
dependency "ledger" {
  config_path = "../ledger"

  mock_outputs = {
    logs_bucket = "mock-ledger-bucket"
  }
}

inputs = {
  shop                  = local.common.locals.shop
  env                   = local.env.locals.env
  name                  = "billing"
  logs_bucket           = dependency.ledger.outputs.logs_bucket
  job_retention_seconds = local.common.locals.job_retention_seconds
}
"""

# The Terragrunt example's scenarios, against example-terragrunt/.
TG_SCENARIOS = {
    "one-unit": [("live/dev/orders/terragrunt.hcl", J, "  # Orders in dev keeps unclaimed jobs for seven days instead of four.\n  job_retention_seconds = 604800\n", 1)],
    "module-bump": [("modules/service/policy.json", '"keep_days": 30', '"keep_days": 60', 1)],
    "destroy": [("live/staging/email/terragrunt.hcl", J, J + "\n  # Email in staging no longer keeps records.\n  records_table = false\n", 1)],
    # A new upstream and a new dependent in one change: the mock trap.
    # New units join the pipeline's waves, so the change carries the pipeline `init` rewrites.
    "new-service": [("live/dev/ledger/terragrunt.hcl", None, LEDGER, 0), ("live/dev/billing/terragrunt.hcl", None, BILLING, 0), INIT],
    # A new file that `terragrunt hcl fmt` would rewrite: the check stage must name it.
    "unformatted": [("live/dev/orders/owner.hcl", None, 'locals {\n    team   = "orders"\n  owner = "shop"\n}\n', 0)],
}

EXAMPLES = {"example": SCENARIOS, "example-terragrunt": TG_SCENARIOS}

def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout

def write_patches(name_dir, scenarios):
  example = os.path.join(HERE, "..", name_dir)
  out = os.path.join(example, "changes")
  with tempfile.TemporaryDirectory() as tmp:
    repo = os.path.join(tmp, "repo")
    shutil.copytree(example, repo, ignore=shutil.ignore_patterns(".terraform", ".terragrunt-cache", "changes"))
    git("init", "-q", cwd=repo)
    git("add", "-A", cwd=repo)
    git("-c", "user.email=a@b", "-c", "user.name=x", "commit", "-qm", "base", cwd=repo)
    for name, edits in scenarios.items():
        for path, old, new, count in edits:
            if count == -1:
                if not os.path.exists(BUNDLE):
                    sys.exit("the bundle is missing; run just build-cli first")
                env = {k: v for k, v in os.environ.items() if k != "TERRAGUCCI_TERRAGRUNT"}
                env["PATH"] = "/usr/bin:/bin"  # no terragrunt: the file walk, so the patch is the same on every machine
                subprocess.run([shutil.which("node") or "node", BUNDLE, "init"], cwd=repo, check=True, capture_output=True, env=env)
                continue
            p = os.path.join(repo, path)
            if old is None:
                os.makedirs(os.path.dirname(p), exist_ok=True)
                open(p, "w").write(new)
                git("add", "-N", path, cwd=repo)
                continue
            s = open(p).read()
            if s.count(old) != count:
                sys.exit(f"{name}: expected {count} of {old!r} in {path}, found {s.count(old)}")
            open(p, "w").write(s.replace(old, new))
        diff = git("diff", cwd=repo)
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, f"{name}.patch"), "w") as f:
            f.write(diff)
        git("reset", "-q", cwd=repo)
        git("checkout", "-q", "--", ".", cwd=repo)
        git("clean", "-qfd", cwd=repo)
        print(f"wrote {name_dir}/changes/{name}.patch")

for name_dir, scenarios in EXAMPLES.items():
    write_patches(name_dir, scenarios)
