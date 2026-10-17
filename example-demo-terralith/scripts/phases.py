#!/usr/bin/env python3
"""Write the terralith scenario's pull requests from the terralith's tree.

    python3 scripts/phases.py        (from example-demo-terralith/)

Reads terralith/iam.tf, versions.tf and logs.tf and writes each beat's
files under scenarios/terralith-<beat>/pull:

  adopt   terralith/state.tf as a live block, and migrations/adopt.yml
  split   the carve of team-b: team-b's root, terralith/ without team-b's
          resources, and migrations/split.yml
  team    team-b's iam.tf with one more action in its inline policy, for
          team-b's own repository, where the root is the repository's top
  cross   terralith/outputs.tf, the log groups team-a and team-c keep in the
          terralith reading it as a local, and team-b's log group reading it
          through data.terraform_estate_outputs

A team owns the blocks whose names start with its name (team_b_role,
team_b_worker, and so on) and its log group from logs.tf. CARVED lists the
teams the split beat carves out; the others stay in the terralith. Names keep
the tree's prefix, "tl"; stack/demo.sh writes the cycle's prefix over it.
"""
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "scenarios")
TEAMS = ["team-a", "team-b", "team-c"]
CARVED = ["team-b"]
CHANGED = "team-b"  # the team whose own repository changes a policy in the team beat
RECORDS = "demo-terralith-records"


def read(*p):
    with open(os.path.join(HERE, *p)) as f:
        return f.read()


def write(rel, text):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def blocks(text):
    """Each top-level resource block as (type, name, text), with the comment
    lines just above it, and the file's header before the first."""
    out, i = [], 0
    head = None
    for m in re.finditer(r'^resource "([^"]+)" "([^"]+)" \{', text, re.M):
        if m.start() < i:
            continue
        start = m.start()
        lines = text[i:start].split("\n")[:-1]
        k = len(lines)
        while k > 0 and lines[k - 1].startswith("#"):
            k -= 1
        lead = "\n".join(lines[k:])
        if head is None:
            head = text[: start - len(lead) - (1 if lead else 0)]
        depth, j = 0, m.end() - 1
        while True:
            c = text[j]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out.append((m.group(1), m.group(2), (lead + "\n" if lead else "") + text[start : j + 1]))
        i = j + 1
    return head or "", out


def live(estate):
    return (
        "terraform {\n  live {\n"
        f'    estate = "{estate}"\n\n'
        f'    record_store "s3" {{\n      bucket = "{RECORDS}"\n    }}\n'
        "  }\n}\n"
    )


TAGGABLE = ("aws_iam_role", "aws_iam_policy", "aws_iam_instance_profile", "aws_cloudwatch_log_group")


def team_of(rtype, name):
    for team in TEAMS:
        key = team.replace("-", "_")
        if name.startswith(key + "_") or (rtype == "aws_cloudwatch_log_group" and name == key):
            return team
    return None


def join(bs):
    return "\n\n".join(b[2] for b in bs) + "\n"


def main():
    iam_head, iam = blocks(read("terralith", "iam.tf"))
    logs_head, logs = blocks(read("terralith", "logs.tf"))
    versions = read("terralith", "versions.tf").replace(
        "# versions.tf - provider wiring only. The backend is in state.tf.",
        "# versions.tf - provider wiring only, copied from the terralith's. The\n# estate's live block is in state.tf.",
    )
    carved = lambda b: team_of(b[0], b[1]) in CARVED

    # adopt: the backend block becomes a live block.
    write("terralith-adopt/pull/terralith/state.tf", "# The terralith as a choudoufu estate: its resources carry the ownership tags\n# live-import stamps, and it keeps no state file.\n" + live("tl-terralith"))
    write(
        "terralith-adopt/pull/migrations/adopt.yml",
        "# Adopt the terralith: choudoufu live-import reads its s3 state once and\n"
        "# stamps tofu-estate and tofu-address on every resource it verifies. The\n"
        "# state file is left in the bucket as it was.\n"
        "backends:\n  - root: terralith\n    from:\n      backend: s3\n      config:\n"
        "        bucket: demo-terralith-state\n        key: tl-terralith.tfstate\n        region: us-east-1\n"
        "        use_lockfile: true\n        use_path_style: true\n",
    )

    # split: the carved teams' roots, the terralith without their resources, and the moves.
    kept_logs = [b for b in logs if not carved(b)]
    write(
        "terralith-split/pull/terralith/iam.tf",
        f"# The identity layer the terralith keeps. {', '.join(CARVED)}'s moved to its own root.\n\n" + join([b for b in iam if not carved(b)]),
    )
    write("terralith-split/pull/terralith/logs.tf", f"# The terralith's team log groups. {', '.join(CARVED)}'s moved to its own root.\n\n" + join(kept_logs))
    moves = ["# Carve " + " and ".join(CARVED) + " out of the terralith: each of its resources moves to",
             "# its own estate. choudoufu live-mv -from-estate rewrites each resource's",
             "# tags, run in the root it moves to; a count block's instances move one by",
             "# one. The untaggable ones (inline policies) follow their role with no write",
             "# of their own.",
             "moves:"]
    for team in CARVED:
        mine = [b for b in iam if team_of(b[0], b[1]) == team]
        log = [b for b in logs if team_of(b[0], b[1]) == team]
        write(f"terralith-split/pull/{team}/state.tf", f"# {team}'s estate, carved from the terralith.\n" + live(f"tl-{team}"))
        write(f"terralith-split/pull/{team}/versions.tf", versions)
        write(f"terralith-split/pull/{team}/iam.tf", f"# {team}'s identity resources, moved from the terralith's iam.tf.\n\n" + join(mine))
        write(f"terralith-split/pull/{team}/logs.tf", f"# {team}'s log group, moved from the terralith's logs.tf.\n\n" + join(log))
        moves += ["  - from: terralith", f"    to: {team}", "    addresses:"]
        moves += [f"      - {t}.{n}" for t, n, _ in mine + log if t in TAGGABLE]
    write("terralith-split/pull/migrations/split.yml", "\n".join(moves) + "\n")

    # team: the team changes its own inline policy, in its own repository.
    key = CHANGED.replace("-", "_")
    changed = []
    for t, n, text in [b for b in iam if team_of(b[0], b[1]) == CHANGED]:
        if n == f"{key}_inline":
            new = text.replace('"dynamodb:DeleteItem"]', '"dynamodb:DeleteItem", "dynamodb:Query"]')
            assert new != text, f"{key}_inline's actions are not where phases.py expects them"
            text = new
        changed.append((t, n, text))
    write("terralith-team/pull/iam.tf", f"# {CHANGED}'s identity resources, moved from the terralith's iam.tf.\n\n" + join(changed))

    # cross: the terralith publishes log_retention_days. The log groups it keeps
    # read the local, and each carved team's log group reads the estate's output.
    write(
        "terralith-cross/pull/terralith/outputs.tf",
        "# A setting every team reads: the log groups the terralith keeps take it\n"
        "# from the local, and each carved team's root from the output, through\n"
        "# data.terraform_estate_outputs.\n"
        "locals {\n  log_retention_days = 14\n}\n\n"
        "output \"log_retention_days\" {\n  value = local.log_retention_days\n}\n",
    )
    text = re.sub(r"retention_in_days = 7\b", "retention_in_days = local.log_retention_days", join(kept_logs))
    write("terralith-cross/pull/terralith/logs.tf", "# The terralith's team log groups, their retention from its own local.\n\n" + text)
    for team in CARVED:
        name = team.replace("-", "_")
        write(
            f"terralith-cross/pull/{team}/logs.tf",
            f"# {team}'s log group, its retention read from the terralith's estate.\n\n"
            f'resource "aws_cloudwatch_log_group" "{name}" {{\n'
            f'  name              = "tl-{team}-logs"\n'
            f"  retention_in_days = data.terraform_estate_outputs.platform.values.log_retention_days\n}}\n\n"
            f'data "terraform_estate_outputs" "platform" {{\n  estate = "tl-terralith"\n  names  = ["log_retention_days"]\n}}\n',
        )


if __name__ == "__main__":
    main()
