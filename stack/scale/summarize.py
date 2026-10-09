#!/usr/bin/env python3
"""One scale run's record, and the record of every run for the site.

scale.sh calls the first form at the end of a run; `scale.sh record` calls
--merge, which folds stack/scale/.state/runs into docs-site/src/data/scale.json:
a run replaces the one at its estate size, and the other sizes stay.
"""

import argparse
import glob
import json
import os
import platform
import re
import sys
from datetime import datetime, timezone

PHASES = ["reconcile", "create", "plan", "change"]


def ts(s):
    """A time from the API or a log line; None for an empty or zero one."""
    if not s or s.startswith("0001-") or s.startswith("1970-"):
        return None
    s = re.sub(r"(\.\d{6})\d+", r"\1", s.replace("Z", "+00:00"))
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def host_load(path):
    """The host's one-minute load average over the run: mean and highest of the samples, and how many."""
    try:
        xs = [float(l) for l in open(path) if l.strip()]
    except (OSError, TypeError, ValueError):
        return None
    if not xs:
        return None
    return {"samples": len(xs), "mean": round(sum(xs) / len(xs), 2), "max": round(max(xs), 2), "cpus": os.cpu_count()}


def run_record(a):
    manifest = json.load(open(a.manifest))
    jobs = [json.loads(line) for line in open(a.jobs) if line.strip()]
    phases = json.loads(a.phases)
    # A phase's wall time runs from its first push or merge to the end of its last run.
    wall = {}
    for line in open(a.runs):
        ph, _, run = line.rstrip("\n").split("\t", 2)
        stop = ts(json.loads(run).get("stopped"))
        if stop:
            wall[ph] = max(wall.get(ph, 0), stop.timestamp() - phases[ph]["start"])
    for p in PHASES:
        if p in phases and p not in wall:
            wall[p] = phases[p]["end"] - phases[p]["start"]
    minutes, longest, runs_ok, failed = {}, {}, True, []
    for j in jobs:
        if j.get("run_status") != "success":
            runs_ok = False
            failed.append(f"{j['repo']} {j['phase']} run ended {j.get('run_status')}")
        start, end = ts(j.get("started_at")), ts(j.get("completed_at"))
        if not start or not end:
            continue
        secs = (end - start).total_seconds()
        minutes[j["phase"]] = minutes.get(j["phase"], 0) + secs / 60
        if secs > longest.get(j["phase"], {}).get("seconds", -1):
            longest[j["phase"]] = {"seconds": round(secs), "job": j["name"], "repo": j["repo"]}
    notes = []
    for line in open(a.notes):
        repo, size, roots, *cut = line.rstrip("\n").split("\t")
        # cut: the note was cut to stay within the forge's comment limit; the job's report has all of it.
        notes.append({"repo": repo, "bytes": int(size), "roots": int(roots), "cut": bool(cut and int(cut[0]))})
    roots_by_repo = {r["name"]: len(r["roots"]) for r in manifest["repos"]}
    for n in notes:
        if n["roots"] != roots_by_repo.get(n["repo"]):
            failed.append(f"{n['repo']}: the plan note covers {n['roots']} of {roots_by_repo.get(n['repo'])} roots")
    reports = []
    for line in open(a.reports):
        if line.strip():
            key, size = line.rstrip("\n").split("\t")
            reports.append((key, int(size)))
    by_name = lambda name: [s for k, s in reports if k.endswith("/" + name)]
    resources = manifest["terralith"]["resources"]
    if int(a.created) != resources:
        failed.append(f"after the create phase the state files held {a.created} of {resources} resources")
    if int(a.held) != resources:
        failed.append(f"after the change phase the state files held {a.held} of {resources} resources")
    rec = {
        "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "release": a.release,
        "substrate": "floci",
        "forge": "forgejo",
        "host": {"os": platform.system().lower(), "arch": platform.machine(), "runner_capacity": int(a.capacity), "parallelism": int(a.parallelism)},
        "estate": {
            "terralith_scale": manifest["terralith"]["scale"],
            "resources": resources,
            "roots": manifest["roots"],
            "repos": len(manifest["repos"]),
            "roots_per_repo": int(a.per_repo),
            "choudoufu_ref": a.choudoufu,
        },
        "host_load": host_load(a.load),
        "passed": runs_ok and not failed,
        # Times the bench restarted its runner because Forgejo left a job waiting with the runner idle.
        "runner_restarts": int(a.restarts or 0),
        "failures": failed,
        "wall_seconds": {**{p: round(wall[p]) for p in PHASES if p in wall}, "total": round(sum(wall.values()))},
        "runner_minutes": {**{p: round(minutes.get(p, 0), 1) for p in PHASES}, "total": round(sum(minutes.values()), 1)},
        "longest_job": longest,
        "note": {
            "bytes_max": max((n["bytes"] for n in notes), default=0),
            "bytes_total": sum(n["bytes"] for n in notes),
            "by_repo": notes,
        },
        "reports": {
            "objects": len(reports),
            "bytes_total": sum(s for _, s in reports),
            "report_json_bytes_max": max(by_name("report.json"), default=0),
            "report_html_bytes_max": max(by_name("report.html"), default=0),
        },
    }
    json.dump(rec, sys.stdout, indent=2)
    print()


def merge(a):
    """The site's record: what it held, with each scale this machine ran replaced by the newer run."""
    held = json.load(open(a.out))["runs"] if os.path.exists(a.out) else []
    by_size = {r["estate"]["resources"]: r for r in held}
    for f in sorted(glob.glob(os.path.join(a.merge, "scale-*.json"))):
        r = json.load(open(f))
        if not r["passed"]:
            print(f"{f}: the run did not pass, so the site keeps what it had", file=sys.stderr)
            continue
        by_size[r["estate"]["resources"]] = r
    runs = list(by_size.values())
    runs.sort(key=lambda r: r["estate"]["resources"])
    with open(a.out, "w") as f:
        json.dump({"runs": runs}, f, indent=2)
        f.write("\n")
    print(f"wrote {len(runs)} run(s) to {a.out}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--merge")
    ap.add_argument("--out")
    for k in ["manifest", "runs", "jobs", "notes", "reports", "phases", "created", "held", "release", "choudoufu", "capacity", "per-repo", "parallelism", "restarts", "load"]:
        ap.add_argument("--" + k)
    a = ap.parse_args()
    merge(a) if a.merge else run_record(a)


if __name__ == "__main__":
    main()
