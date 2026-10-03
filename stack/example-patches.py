#!/usr/bin/env python3
"""Regenerate example/changes/*.patch from the example as committed.

Each scenario is an edit described here, applied to a clean copy of example/
and saved as a git diff, so the patches always apply to the example's main.
Run it after changing anything under example/envs or example/modules.
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

def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout

with tempfile.TemporaryDirectory() as tmp:
    repo = os.path.join(tmp, "repo")
    shutil.copytree(EXAMPLE, repo, ignore=shutil.ignore_patterns(".terraform", "changes"))
    git("init", "-q", cwd=repo)
    git("add", "-A", cwd=repo)
    git("-c", "user.email=a@b", "-c", "user.name=x", "commit", "-qm", "base", cwd=repo)
    for name, edits in SCENARIOS.items():
        for path, old, new, count in edits:
            p = os.path.join(repo, path)
            if old is None:
                open(p, "w").write(new)
                git("add", "-N", path, cwd=repo)
                continue
            s = open(p).read()
            if s.count(old) != count:
                sys.exit(f"{name}: expected {count} of {old!r} in {path}, found {s.count(old)}")
            open(p, "w").write(s.replace(old, new))
        diff = git("diff", cwd=repo)
        with open(os.path.join(OUT, f"{name}.patch"), "w") as f:
            f.write(diff)
        git("reset", "-q", cwd=repo)
        git("checkout", "-q", "--", ".", cwd=repo)
        git("clean", "-qfd", cwd=repo)
        print(f"wrote changes/{name}.patch")
