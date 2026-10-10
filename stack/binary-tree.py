#!/usr/bin/env python3
"""A claim's tree, written for another binary (stack/smoke.sh, SMOKE_BINARY).

    binary-tree.py <dir> <binary> <name> [--records BUCKET] [--endpoint URL] [--names TAG]

<binary> is terraform or choudoufu; tofu leaves the tree as it is.

- terragucci.yml says `binary: <binary>`.
- terraform: a root's `required_version = "~> 1.13.0"` becomes ">= 1.13.0",
  since it pins OpenTofu's line, which Terraform 1.14 does not meet, and a
  lock file of OpenTofu's registry becomes Terraform's
  (fixtures/terraform-lock).
- choudoufu: each root runs on choudoufu's own backend, a `live` block, since
  its live check refuses a root with a state backend and a logical resource.
  A `backend "s3"` becomes a record store in BUCKET (--records), a
  `backend "local"` the local store, and each root is its own estate:
  <name>--<the root's path, with / as -->. A
  `terraform_remote_state` read becomes a `terraform_estate_outputs` read of
  the estate that holds that state, since a live root keeps no state file.
  `drift:` is left out of terragucci.yml (--keep-drift keeps it): init
  refuses it for roots under live resource markers.
  --endpoint adds `env: AWS_ENDPOINT_URL_S3` to terragucci.yml, the host the
  record store is addressed on (virtual-hosted, <bucket>.<host>). It is S3's
  own endpoint variable, since a runner's AWS_ENDPOINT_URL wins over the
  pipeline's env.
- --names TAG puts the example's names (shop-...) under shop<TAG>-, so a
  binary's copy of the example shares no resource, bucket or state with it.

Prints each estate as "<root> <estate>", one per line, for choudoufu.
"""
import argparse
import os
import re
import sys

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("binary", choices=["tofu", "terraform", "choudoufu"])
ap.add_argument("name")
ap.add_argument("--records", default="terragucci-smoke-records")
ap.add_argument("--endpoint", default="")
ap.add_argument("--names", default="")
ap.add_argument("--keep-drift", action="store_true")
a = ap.parse_args()
tree = os.path.abspath(a.dir)


def block_end(text, start):
    """The index just past the block whose first { is at or after start."""
    depth = 0
    for i in range(text.index("{", start), len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i + 1
    raise SystemExit(f"binary-tree: an unclosed block at {start}")


def attr(body, name):
    m = re.search(r'\b%s\s*=\s*"([^"]*)"' % name, body)
    return m.group(1) if m else None


def estate(*parts):
    s = "--".join(p.strip("/") for p in parts if p)
    s = re.sub(r"\.tfstate$", "", s).replace("/", "--").lower()
    return re.sub(r"[^a-z0-9-]", "-", s)[:128]


def tf_files():
    for dirpath, dirnames, files in os.walk(tree):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d != "node_modules")
        for f in sorted(files):
            if f.endswith(".tf"):
                yield dirpath, os.path.join(dirpath, f)


if a.binary == "tofu":
    sys.exit(0)

if a.names:
    for _, path in tf_files():
        text = open(path).read()
        new = text.replace("shop-", f"shop{a.names}-")
        if new != text:
            open(path, "w").write(new)

estates = {}
if a.binary == "terraform":
    for _, path in tf_files():
        text = open(path).read()
        new = re.sub(r'^(\s*required_version\s*=\s*)"~>\s*([0-9]+\.[0-9]+)\.[0-9]+"', r'\1">= \2.0"', text, flags=re.M)
        if new != text:
            open(path, "w").write(new)
    # A lock file of OpenTofu's registry means nothing to Terraform: put
    # Terraform's in its place, as a Terraform repo commits it.
    lock = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures/terraform-lock/aws-6.67.0.terraform.lock.hcl")).read()
    for dirpath, dirnames, files in os.walk(tree):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if ".terraform.lock.hcl" in files:
            path = os.path.join(dirpath, ".terraform.lock.hcl")
            text = open(path).read()
            if 'provider "registry.opentofu.org/hashicorp/aws"' in text and 'version     = "6.67.0"' in text:
                open(path, "w").write(lock)
elif a.binary == "choudoufu":
    # First pass: each root's estate, keyed by the state key its backend names.
    by_key = {}
    roots = {}
    for dirpath, path in tf_files():
        text = open(path).read()
        m = re.search(r'\bbackend\s+"(s3|local)"\s*\{', text)
        if not m:
            continue
        root = os.path.relpath(dirpath, tree)
        key = attr(text[m.start():block_end(text, m.start())], "key") if m.group(1) == "s3" else None
        e = estate(a.name, root)
        roots[path] = (m.group(1), e)
        estates[root] = e
        if key:
            by_key[key] = e
    for dirpath, path in tf_files():
        text = open(path).read()
        out = text
        if path in roots:
            kind, e = roots[path]
            m = re.search(r'\bbackend\s+"(s3|local)"\s*\{', out)
            store = f'\n\n    record_store "s3" {{\n      bucket = "{a.records}"\n    }}' if kind == "s3" else ""
            out = out[:m.start()] + f'live {{\n    estate = "{e}"{store}\n  }}' + out[block_end(out, m.start()):]
        # choudoufu admits no aws_s3_object under live markers; the same
        # content, kept by a terraform_data, keeps the dependency it carries.
        while True:
            m = re.search(r'\bresource\s+"aws_s3_object"\s+"([^"]+)"\s*\{', out)
            if not m:
                break
            end = block_end(out, m.start())
            inner = out[out.index("{", m.start()) + 1:end - 1]
            body = "\n".join("  " + line if line.strip() else line for line in inner.strip("\n").splitlines())
            out = out[:m.start()] + f'resource "terraform_data" "{m.group(1)}" {{\n  input = {{\n{body}\n  }}\n}}' + out[end:]
        # terraform_remote_state reads become estate output reads.
        while True:
            m = re.search(r'\bdata\s+"terraform_remote_state"\s+"([^"]+)"\s*\{', out)
            if not m:
                break
            label, end = m.group(1), block_end(out, m.start())
            key = attr(out[m.start():end], "key")
            if key not in by_key:
                raise SystemExit(f"binary-tree: {path} reads the state {key}, which no root here holds")
            names = sorted(set(re.findall(r"\bdata\.terraform_remote_state\.%s\.outputs\.([A-Za-z0-9_]+)" % re.escape(label), out)))
            listed = ", ".join(f'"{n}"' for n in names)
            out = out[:m.start()] + f'data "terraform_estate_outputs" "{label}" {{\n  estate = "{by_key[key]}"\n  names  = [{listed}]\n}}' + out[end:]
            out = re.sub(r"\bdata\.terraform_remote_state\.%s\.outputs\." % re.escape(label), f"data.terraform_estate_outputs.{label}.values.", out)
        if out != text:
            open(path, "w").write(out)
    ignore = os.path.join(tree, ".gitignore")
    lines = open(ignore).read().splitlines() if os.path.exists(ignore) else []
    if ".tofu-records/" not in lines:
        open(ignore, "a").write(("\n" if lines and lines[-1] else "") + ".tofu-records/\n")

cfg = os.path.join(tree, "terragucci.yml")
text = open(cfg).read() if os.path.exists(cfg) else ""
if re.search(r"^binary:.*$", text, re.M):
    text = re.sub(r"^binary:.*$", f"binary: {a.binary}", text, count=1, flags=re.M)
else:
    text = f"binary: {a.binary}\n" + text
# A drift check is refused under live resource markers (init's config error),
# so a choudoufu tree runs no drift schedule unless asked to keep it.
if a.binary == "choudoufu" and not a.keep_drift:
    text = re.sub(r"^drift:.*\n", "", text, flags=re.M)
if a.endpoint:
    if re.search(r"^env:\s*$", text, re.M):
        text = re.sub(r"^env:\s*\n", f"env:\n  AWS_ENDPOINT_URL_S3: {a.endpoint}\n", text, count=1, flags=re.M)
    elif re.search(r"^env:", text, re.M):
        raise SystemExit("binary-tree: terragucci.yml has an env: this script cannot add to")
    else:
        text = text + ("" if text.endswith("\n") or not text else "\n") + f"env:\n  AWS_ENDPOINT_URL_S3: {a.endpoint}\n"
open(cfg, "w").write(text)

for root, e in sorted(estates.items()):
    print(f"{root} {e}")
