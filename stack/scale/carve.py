#!/usr/bin/env python3
"""Carve a terralith into many roots across several repos.

terralith-gen (tools/terralith-gen in INTENTIUS/choudoufu) writes one root
module of 74*scale+5 AWS resources. This splits it, block by block, into the
shape a team that outgrew one root would have: one root per team, per service,
per ten DNS records and per pair of count-expanded or module-nested teams, plus
one platform root that holds the shared network, cluster and zone. Every
resource keeps its terralith name, so the carved estate declares exactly the
resources the terralith does.

  carve.py --terralith DIR --out DIR [--roots-per-repo N] [--bucket NAME]

The out directory gets one directory per repo and estate.json, which names
every repo, its roots and the resources each root declares. The platform repo
holds the platform root and every root that reads its state (services, DNS), so
each state read stays inside one repo and terragucci's waves order it. The
identity roots read nothing and fill the other repos, N roots each.

Every root calls the repo's modules/estate, whose `tags` output the provider
applies as default tags. A change to that module reaches every root of the
repo, which is how the bench plans every root on a pull request.

Each root gets terraform.lock.hcl, beside this script, as its
.terraform.lock.hcl, as a repo that commits its lock files has. Without one,
init does not take the provider from the plugin cache and downloads it again
for every root.
"""

import argparse
import json
import os
import re
import sys

PROVIDER_VERSION = "6.59.0"


def blocks(path):
    """The top-level blocks of a generated .tf file: (header, text)."""
    out, cur = [], None
    with open(path) as f:
        for line in f:
            if cur is None:
                if re.match(r"^(resource|module|locals|data|output|variable|terraform|provider)\b", line):
                    cur = [line]
            else:
                cur.append(line)
                if line.rstrip("\n") == "}":
                    out.append((cur[0].strip(), "".join(cur)))
                    cur = None
    return out


def by_name(tf_blocks):
    named = {}
    for header, text in tf_blocks:
        m = re.match(r'resource "([^"]+)" "([^"]+)"', header)
        if m:
            named[(m.group(1), m.group(2))] = text
    return named


def header(key, bucket, modules_rel, state_reads):
    remote = ""
    if state_reads:
        remote = f'''
data "terraform_remote_state" "platform" {{
  backend = "s3"
  config = {{
    bucket         = "{bucket}"
    key            = "platform/platform.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }}
}}
'''
    return f'''# Carved from a terralith by stack/scale/carve.py.

terraform {{
  required_version = ">= 1.5.0"

  required_providers {{
    aws = {{
      source  = "hashicorp/aws"
      version = "= {PROVIDER_VERSION}"
    }}
  }}

  backend "s3" {{
    bucket         = "{bucket}"
    key            = "{key}"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }}
}}

provider "aws" {{
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  default_tags {{
    tags = module.estate.tags
  }}
}}

module "estate" {{
  source = "{modules_rel}/modules/estate"
}}
{remote}'''


ESTATE_MODULE = '''# The tags every root of this repo applies to what it declares. A change here
# reaches every root.

output "tags" {
  value = {
    estate   = "terralith"
    revision = "1"
  }
}
'''

PLATFORM_OUTPUTS = '''
output "subnet_id" {
  value = aws_subnet.main.id
}

output "security_group_id" {
  value = aws_security_group.ecs.id
}

output "cluster_id" {
  value = aws_ecs_cluster.main.id
}

output "zone_id" {
  value = aws_route53_zone.main.zone_id
}

output "zone_name" {
  value = aws_route53_zone.main.name
}
'''


def platform_refs(text):
    rs = "data.terraform_remote_state.platform.outputs"
    return (text.replace("aws_ecs_cluster.main.id", f"{rs}.cluster_id")
            .replace("aws_subnet.main.id", f"{rs}.subnet_id")
            .replace("aws_security_group.ecs.id", f"{rs}.security_group_id")
            .replace("aws_route53_zone.main.zone_id", f"{rs}.zone_id")
            .replace("aws_route53_zone.main.name", f"{rs}.zone_name"))


def offset(text, n):
    return text.replace('format("%04d", count.index)', f'format("%04d", count.index + {n})')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--terralith", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--roots-per-repo", type=int, default=100)
    ap.add_argument("--bucket", default="terralith-state")
    a = ap.parse_args()

    t = a.terralith
    named = {}
    for f in ("iam.tf", "ecs.tf", "dns.tf", "network.tf"):
        named.update(by_name(blocks(os.path.join(t, f))))
    main_tf = open(os.path.join(t, "main.tf")).read()
    pod_size = int(re.search(r"pod_size\s*=\s*(\d+)", main_tf).group(1))
    image = re.search(r'placeholder_image\s*=\s*"([^"]+)"', main_tf).group(1)
    prefix = re.search(r'name_prefix\s*=\s*"([^"]+)"', main_tf).group(1)
    dns_text = open(os.path.join(t, "dns.tf")).read()
    records = re.findall(r'^\s+("host-\d+" = \{[^\n]*\})$', dns_text, re.M)
    count_teams = int(re.search(r'resource "aws_iam_role" "count_team" \{\s*count\s*=\s*(\d+)', open(os.path.join(t, "iam.tf")).read()).group(1))
    teams = sorted({m.group(1) for k in named for m in [re.match(r"(team_\d+)_role$", k[1])] if m})
    services = sorted({m.group(1) for k in named for m in [re.match(r"(svc_\d+)$", k[1])] if m and k[0] == "aws_ecs_service"})
    pod_keys = re.findall(r'"([^"]+)"', re.search(r"for_each\s*=\s*toset\(\[([^\]]*)\]\)", open(os.path.join(t, "pods.tf")).read()).group(1))

    roots = []  # (repo kind, path, text, resources, reads platform)

    def add(kind, path, body, n, reads=False):
        roots.append({"kind": kind, "path": path, "body": body, "resources": n, "reads": reads})

    add("platform", "platform",
        "".join(named[k] + "\n" for k in [("aws_vpc", "main"), ("aws_subnet", "main"), ("aws_security_group", "ecs"), ("aws_ecs_cluster", "main"), ("aws_route53_zone", "main")]) + PLATFORM_OUTPUTS, 5)
    for s in services:
        body = f'locals {{\n  placeholder_image = "{image}"\n}}\n\n'
        body += "".join(named[k] + "\n" for k in [("aws_iam_role", f"{s}_exec_role"), ("aws_iam_role_policy_attachment", f"{s}_exec_attach"), ("aws_ecs_task_definition", s), ("aws_ecs_service", s)])
        add("platform", f"services/{s.replace('_', '-')}", platform_refs(body), 4, True)
    record_block = platform_refs(named[("aws_route53_record", "record")])
    for i in range(0, len(records), 10):
        chunk = records[i:i + 10]
        body = "locals {\n  dns_records = {\n" + "".join(f"    {r}\n" for r in chunk) + "  }\n}\n\n" + record_block
        add("platform", f"dns/records-{i // 10:04d}", body, len(chunk), True)
    for team in teams:
        body = "".join(text + "\n" for (kind, name), text in named.items() if name.startswith(team + "_"))
        n = sum(1 for (_, name) in named if name.startswith(team + "_"))
        add("identity", f"teams/{team.replace('_', '-')}", body, n)
    count_blocks = [text for (_, name), text in named.items() if name.startswith("count_team")]
    for i in range(0, count_teams, 2):
        body = "".join(offset(re.sub(r"count(\s*)= \d+", r"count\1= 2", b, count=1), i) + "\n" for b in count_blocks)
        add("identity", f"count-teams/chunk-{i // 2:04d}", body, 2 * len(count_blocks))
    pod_resources = len(re.findall(r'^resource ', open(os.path.join(t, "modules/team_pod/main.tf")).read(), re.M))
    for i in range(pod_size):
        keys = ", ".join(f'"{k}"' for k in pod_keys)
        body = f'''module "team_pod" {{
  source = "../../modules/team_pod"

  for_each = toset([{keys}])

  prefix   = "{prefix}-${{each.key}}"
  pod_size = 1
  offset   = {i}
}}
'''
        add("identity", f"pods/chunk-{i:04d}", body, len(pod_keys) * pod_resources)

    lock = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "terraform.lock.hcl")).read()
    if f'version     = "{PROVIDER_VERSION}"' not in lock:
        sys.exit(f"carve.py: terraform.lock.hcl does not lock hashicorp/aws {PROVIDER_VERSION}")
    pod_main = offset(open(os.path.join(t, "modules/team_pod/main.tf")).read(), "var.offset")
    pod_vars = open(os.path.join(t, "modules/team_pod/variables.tf")).read() + '\nvariable "offset" {\n  type    = number\n  default = 0\n}\n'

    # Spread the roots over repos: the platform repo, then the identity roots N at a time.
    repos = {"platform": [r for r in roots if r["kind"] == "platform"]}
    ident = [r for r in roots if r["kind"] == "identity"]
    for i in range(0, len(ident), a.roots_per_repo):
        repos[f"identity-{i // a.roots_per_repo:02d}"] = ident[i:i + a.roots_per_repo]

    manifest = {"terralith": {"scale": None, "resources": None}, "repos": []}
    total = 0
    for repo, rs in repos.items():
        rdir = os.path.join(a.out, repo)
        os.makedirs(os.path.join(rdir, "modules/estate"), exist_ok=True)
        with open(os.path.join(rdir, "modules/estate/main.tf"), "w") as f:
            f.write(ESTATE_MODULE)
        if any(r["path"].startswith("pods/") for r in rs):
            os.makedirs(os.path.join(rdir, "modules/team_pod"), exist_ok=True)
            with open(os.path.join(rdir, "modules/team_pod/main.tf"), "w") as f:
                f.write(pod_main)
            with open(os.path.join(rdir, "modules/team_pod/variables.tf"), "w") as f:
                f.write(pod_vars)
        with open(os.path.join(rdir, "README.md"), "w") as f:
            f.write(f"# {repo}\n\nPart of a terralith carved into roots by terragucci's stack/scale/carve.py.\n")
        for r in rs:
            d = os.path.join(rdir, r["path"])
            os.makedirs(d, exist_ok=True)
            depth = "/".join([".."] * len(r["path"].split("/")))
            with open(os.path.join(d, "main.tf"), "w") as f:
                f.write(header(f"{repo}/{r['path']}.tfstate", a.bucket, depth, r["reads"]))
                f.write("\n" + r["body"].rstrip("\n") + "\n")
            with open(os.path.join(d, ".terraform.lock.hcl"), "w") as f:
                f.write(lock)
            total += r["resources"]
        manifest["repos"].append({"name": repo, "roots": [{"path": r["path"], "resources": r["resources"]} for r in rs]})

    gen = open(os.path.join(t, "GENERATED.md")).read()
    scale = int(re.search(r"scale=(\d+)", gen).group(1))
    want = int(re.search(r"\*\*total\*\* \| \*\*(\d+)\*\*", gen).group(1))
    if total != want:
        sys.exit(f"carve.py: the carved roots declare {total} resources and the terralith {want}")
    manifest["terralith"] = {"scale": scale, "resources": want}
    manifest["roots"] = sum(len(r["roots"]) for r in manifest["repos"])
    with open(os.path.join(a.out, "estate.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"carved terralith scale {scale}: {want} resources, {manifest['roots']} roots, {len(repos)} repos", file=sys.stderr)


if __name__ == "__main__":
    main()
