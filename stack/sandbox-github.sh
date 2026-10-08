#!/usr/bin/env bash
#
# The GitHub sandbox: a plan-only copy of the example on github.com
# (INTENTIUS/terragucci-sandbox), run by the pipeline `npx terragucci init`
# writes, on the published images. The docs' GitHub screenshots come from it.
# It needs no stack, no cloud account and no secret in the repo.
#
#   stack/sandbox-github.sh up [--fresh]   push the plan-only example as the
#                                     sandbox's first commit when the repo is
#                                     empty (--fresh: replace it) and wait for
#                                     the apply
#   stack/sandbox-github.sh change <s>     open a pull request with a scenario
#                                     (one-root, module-bump, destroy, replace,
#                                     unformatted) and wait for its plan
#   stack/sandbox-github.sh merge <s>      merge it, listing this run's signer
#                                     key in .chant/allowed_signers first, and
#                                     show which wave waits or refuses
#   stack/sandbox-github.sh approve [wave-N] [--hold]
#                                     approve the waiting wave with chant,
#                                     sealed with this run's key, then re-run
#                                     the stopped jobs (--hold: approve only)
#   stack/sandbox-github.sh plan-comment [s]  comment `/terragucci plan` on the
#                                     scenario's pull request (default: the
#                                     newest open one) and wait for the reply
#   stack/sandbox-github.sh drift          delete a file a root keeps outside
#                                     the code, run the drift job and wait for
#                                     its issue
#   stack/sandbox-github.sh capture        from a reset sandbox: every scenario
#                                     the docs show, screenshotted into
#                                     docs-site as step `github`, then reset
#   stack/sandbox-github.sh reset          close the pull requests and issues,
#                                     delete every other branch and put main
#                                     back to its first commit
#   stack/sandbox-github.sh shot <view>|all|list
#                                     screenshot a page a step recorded, logged
#                                     out, light and dark
#   stack/sandbox-github.sh minutes [ISO-time]
#                                     the sandbox's Actions run time since then
#
# The token comes from TERRAGUCCI_SANDBOX_TOKEN, else `gh auth token`, at run
# time. It is handed to gh and git through the environment of this process
# only: never written to a file, a git config or a log.
#
# Scratch files (the signer key, the recorded views, job logs, screenshots) go
# in TERRAGUCCI_SANDBOX_DIR, default $TMPDIR/terragucci-sandbox. The signer key
# is made for one run and its private half never leaves that directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/../example" && pwd)"
CMD="${1:-}"; shift || true

REPO="${TERRAGUCCI_SANDBOX_REPO:-INTENTIUS/terragucci-sandbox}"
DIR="${TERRAGUCCI_SANDBOX_DIR:-${TMPDIR:-/tmp}/terragucci-sandbox}"
DIR="${DIR%/}"
# The published release whose `init` writes the pipeline, and so its images.
RELEASE="${TERRAGUCCI_SANDBOX_RELEASE:-0.3.1}"
# The container stack/shot.mjs runs in: Node 22 and Chromium.
SHOT_IMAGE="${TERRAGUCCI_SHOT_IMAGE:-mcr.microsoft.com/playwright:v1.55.0-noble}"
SIGNER="sandbox-signer"
# 1: the sandbox's terragucci.yml marks the checkout safe for git (build_main).
SAFE_DIRECTORY="${TERRAGUCCI_SANDBOX_SAFE_DIRECTORY:-0}"
WEB="https://github.com/$REPO"

log()  { echo "[sandbox] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

usage() { sed -n '3,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; }
case "$CMD" in up|change|merge|approve|plan-comment|drift|capture|reset|shot|minutes) ;; *) usage; exit 2 ;; esac

command -v gh >/dev/null 2>&1 || fail "gh is not installed"
command -v jq >/dev/null 2>&1 || fail "jq is not installed"
mkdir -p "$DIR/views" "$DIR/logs" "$DIR/shots"
chmod 700 "$DIR"

TOKEN="${TERRAGUCCI_SANDBOX_TOKEN:-}"
[ -n "$TOKEN" ] || TOKEN="$(gh auth token 2>/dev/null || true)"
[ -n "$TOKEN" ] || fail "no token: set TERRAGUCCI_SANDBOX_TOKEN or run 'gh auth login'"
# gh reads GH_TOKEN. git asks the helper below, which reads the variable; the
# empty helper first drops any helper (a keychain) that would store it.
export GH_TOKEN="$TOKEN" SANDBOX_GIT_TOKEN="$TOKEN"
# shellcheck disable=SC2016 # git's shell expands it, from the environment
export GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0="" \
  GIT_CONFIG_KEY_1=credential.helper \
  GIT_CONFIG_VALUE_1='!f() { echo username=x-access-token; echo "password=$SANDBOX_GIT_TOKEN"; }; f'
unset TOKEN
GIT_URL="https://github.com/$REPO.git"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-sandbox.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── the plan-only tree ───────────────────────────────────────────────────────

# The example with every AWS resource swapped for a terraform_data stand-in
# whose input holds the resource's arguments, and whose triggers_replace holds
# the arguments that replace the real resource, so a plan reads like the
# example's: an update in place, a replacement or a destroy. main.tf keeps its
# s3 backend, so `init` finds the same four waves as on the example; each root's
# state_override.tf points the backend at terraform.tfstate beside the code.
plan_only() { # example dir, out dir
  python3 - "$1" "$2" <<'PY'
import os, re, shutil, sys

src, dst = sys.argv[1], sys.argv[2]
FORCES_NEW = {"aws_s3_bucket": ["bucket"], "aws_sqs_queue": ["name"], "aws_dynamodb_table": ["name", "hash_key"], "aws_s3_object": ["bucket", "key"]}
META = {"count", "for_each", "depends_on", "provider", "lifecycle"}

def block_end(text, brace):
    depth = 0
    for i in range(brace, len(text)):
        if text[i] == "{": depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0: return i
    raise SystemExit("unbalanced braces")

def opens(line):
    return sum(line.count(c) for c in "{([") - sum(line.count(c) for c in "})]")

def items(body):
    """A block body's top-level items: (kind, name, lines)."""
    lines, out, i = body.split("\n"), [], 0
    while i < len(lines):
        s = lines[i].strip()
        if not s or s.startswith("#"):
            out.append(("text", None, [lines[i]])); i += 1; continue
        m = re.match(r"(\w+)\s*(=)?", s)
        chunk, depth = [lines[i]], opens(lines[i])
        while depth > 0:
            i += 1; chunk.append(lines[i]); depth += opens(lines[i])
        out.append(("attr" if m.group(2) else "block", m.group(1), chunk)); i += 1
    return out

def resource(rtype, name, body):
    meta, inputs, forces = [], [], []
    for kind, n, chunk in items(body):
        if kind == "text":
            (inputs if inputs else meta).append(chunk); continue
        if n in META:
            meta.append(chunk); continue
        if kind == "block":
            chunk = [re.sub(r"^(\s*)(\w+)\s*\{", r"\1\2 = {", chunk[0])] + chunk[1:]
        elif n in FORCES_NEW.get(rtype, []):
            forces.append(re.sub(r"^\s*\w+\s*=\s*", "", chunk[0]).strip())
        inputs.append(["  " + l if l.strip() else l for l in chunk])
    while meta and not meta[-1][0].strip(): meta.pop()
    while inputs and not inputs[0][0].strip(): inputs.pop(0)
    while inputs and not inputs[-1][0].strip(): inputs.pop()
    out = [f'resource "terraform_data" "{name}" {{']
    for c in meta: out += c
    if meta: out.append("")
    out.append("  input = {")
    for c in inputs: out += c
    out.append("  }")
    if forces: out += ["", f"  triggers_replace = [{', '.join(forces)}]"]
    return "\n".join(out + ["}"])

def drop_block(text, pattern):
    m = re.search(pattern, text)
    if not m: return text
    stop = block_end(text, m.end() - 1) + 1
    while text[stop:stop + 2] == "\n\n": stop += 1
    return text[:m.start()] + text[stop + 1:]

def convert(text):
    text = drop_block(text, r'(?m)^[ \t]*required_providers\s*\{')
    text = drop_block(text, r'(?m)^provider\s+"aws"\s*\{')
    while m := re.search(r'(?m)^resource\s+"(aws_[a-z0-9_]+)"\s+"(\w+)"\s*\{', text):
        end = block_end(text, m.end() - 1)
        text = text[:m.start()] + resource(m.group(1), m.group(2), text[m.end():end].strip("\n")) + text[end + 1:]
    # aws_x.name[i].attr reads the stand-in's input; an arn stands in as the name.
    return re.sub(r"\baws_[a-z0-9_]+\.(\w+)(\[[^\]]*\])?\.(\w+)",
                  lambda m: f"terraform_data.{m.group(1)}{m.group(2) or ''}.input.{'name' if m.group(3) == 'arn' else m.group(3)}", text)

OVERRIDE = """# The sandbox keeps each root's state in this repo, beside its code, because a
# GitHub-hosted job reaches no state store without an account. This file
# overrides the s3 backend in main.tf{what}.
terraform {{
  backend "local" {{}}
}}
"""
READ = """
data "terraform_remote_state" "platform" {
  backend = "local"
  config = {
    path = "../platform/terraform.tfstate"
  }
}
"""

shutil.copytree(src, dst, dirs_exist_ok=True,
                ignore=shutil.ignore_patterns(".terraform", ".forgejo", ".github", "changes", ".terraform.lock.hcl", "README.md", "*.tfstate", "*.tfstate.*"))
for base, _, files in os.walk(dst):
    for f in files:
        if not f.endswith(".tf") or f == "state_override.tf": continue
        p = os.path.join(base, f)
        text = convert(open(p).read())
        open(p, "w").write(text)
        if re.search(r'backend\s+"s3"', text):
            reads = 'data "terraform_remote_state" "platform"' in text
            with open(os.path.join(base, "state_override.tf"), "w") as o:
                o.write(OVERRIDE.format(what=" and the platform root's state it reads" if reads else ""))
                if reads: o.write(READ)
open(os.path.join(dst, ".gitignore"), "w").write(".terraform/\n*.tfstate.backup\n.terraform.tfstate.lock.info\ntfplan\n")
PY
}

readme() { # dir
  cat > "$1/README.md" <<EOF
# terragucci sandbox

A plan-only copy of the [terragucci example](https://github.com/INTENTIUS/terragucci/tree/main/example), run by \`stack/sandbox-github.sh\` in [INTENTIUS/terragucci](https://github.com/INTENTIUS/terragucci). The GitHub screenshots in terragucci's docs are taken here.

| What | How |
|---|---|
| Resources | each AWS resource of the example is a \`terraform_data\` holding its arguments, so a plan or an apply needs no cloud account and spends nothing |
| State | each root's \`terraform.tfstate\` sits beside its code; \`state_override.tf\` points the backend there, and the script commits the state after an apply |
| Pipeline | \`.github/workflows/terragucci.yml\` as \`npx @intentius/terragucci@$RELEASE init\` writes it, on the published images |
| Approvals | \`.chant/allowed_signers\` lists a key made for one sandbox run |

The script resets this repo to its first commit, so its pull requests and history do not last.
EOF
}

# The roots, platforms first: a root that reads another's state comes after it.
roots_in_order() { # dir
  (cd "$1" && find envs -name state_override.tf | LC_ALL=C sort | while read -r f; do
    d="$(dirname "$f")"; grep -q terraform_remote_state "$f" && echo "1 $d" || echo "0 $d"; done | sort -k1,1 -s | cut -d' ' -f2)
}

# The tofu image the pipeline pins, by digest.
pipeline_image() { # dir
  awk '$1 == "image:" { print $2; exit }' "$1/.github/workflows/terragucci.yml"
}

# Apply every root in the pipeline's own image, so each terraform.tfstate holds
# what the tree declares. The pipeline's apply runs on a GitHub runner whose
# disk is gone after the job; this writes the same state into the tree.
apply_state() { # dir
  local dir="$1" image roots
  image="$(pipeline_image "$dir")"
  [ -n "$image" ] || fail "no image in $dir/.github/workflows/terragucci.yml"
  roots="$(roots_in_order "$dir" | tr '\n' ' ')"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e TF_IN_AUTOMATION=1 -v "$dir:/w" -w /w --entrypoint sh "$image" -c '
    set -e
    for d in '"$roots"'; do
      (cd "$d" && tofu init -input=false >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null) || { echo "apply failed in $d" >&2; exit 1; }
    done' || fail "the state apply failed"
  find "$dir" -name .terraform -type d -prune -exec rm -rf {} +
  find "$dir" -name '*.tfstate.backup' -delete
}

# The first commit's tree: the plan-only example, its pipeline and its state.
build_main() { # dir
  local dir="$1"
  plan_only "$EXAMPLE" "$dir"
  readme "$dir"
  if [ "$SAFE_DIRECTORY" = 1 ]; then
    cat >> "$dir/terragucci.yml" <<'EOF'
# The 0.3.0 pipeline's container jobs run git as root in a checkout the runner's
# user owns, and git refuses such a checkout until it is marked safe. Without
# this, a comment re-plan stops, a plan covers every root and an apply cannot
# tell what moved.
env:
  GIT_CONFIG_COUNT: "1"
  GIT_CONFIG_KEY_0: safe.directory
  GIT_CONFIG_VALUE_0: "*"
EOF
  fi
  git -C "$dir" init -q -b main
  git -C "$dir" remote add origin "$GIT_URL"
  (cd "$dir" && npx -y "@intentius/terragucci@$RELEASE" init >"$DIR/logs/init.log" 2>&1) \
    || { cat "$DIR/logs/init.log" >&2; fail "terragucci init failed"; }
  [ -f "$dir/.github/workflows/terragucci.yml" ] || fail "init wrote no .github/workflows/terragucci.yml"
  apply_state "$dir"
}

# A scenario as a patch to the plan-only tree: the example before and after
# its change, both made plan-only, and the difference.
scenario_patch() { # scenario -> prints the patch path
  local name="$1" d="$WORK/scenario-$1"
  [ -f "$EXAMPLE/changes/$name.patch" ] || fail "no example/changes/$name.patch"
  mkdir -p "$d/real"
  cp -R "$EXAMPLE/." "$d/real/"
  (cd "$d/real" && git apply "$EXAMPLE/changes/$name.patch") || fail "changes/$name.patch does not apply to example/"
  plan_only "$EXAMPLE" "$d/before"
  plan_only "$d/real" "$d/after"
  (cd "$d" && git diff --no-index --no-prefix before after > "$d.patch") || true
  [ -s "$d.patch" ] || fail "$name changes nothing in the plan-only copy"
  echo "$d.patch"
}

title_of() { # scenario
  case "$1" in
    one-root) echo "Keep dev orders' unclaimed jobs for seven days" ;;
    module-bump) echo "Wait 60 seconds before retrying a job, in every service" ;;
    replace) echo "Key prod search's records by sku" ;;
    destroy) echo "Stop keeping records for staging email" ;;
    unformatted) echo "Add an owner to dev orders, without running tofu fmt" ;;
    *) fail "unknown scenario '$1' (one-root, module-bump, destroy, replace, unformatted)" ;;
  esac
}

# ── git and runs ─────────────────────────────────────────────────────────────

clone_main() { # dir
  git clone -q "$GIT_URL" "$1" 2>/dev/null || fail "could not clone $REPO"
  git -C "$1" rev-parse -q --verify HEAD >/dev/null || fail "$REPO is empty; run 'just sandbox up' first"
}

commit() { # dir, message
  git -C "$1" add -A
  git -C "$1" -c user.name=terragucci -c user.email=sandbox@terragucci.local -c commit.gpgsign=false \
    commit -q -m "$2"
}

push() { # dir, branch [--force]
  git -C "$1" push -q ${3:+--force} origin "HEAD:refs/heads/$2" 2>"$WORK/push.err" \
    || { cat "$WORK/push.err" >&2; fail "could not push $2"; }
  git -C "$1" rev-parse HEAD
}

# Wait with `gh run watch` for the newest run an event started at or after a
# time, on one commit or any. Sets RUN_ID, RUN_URL and RUN_CONCLUSION.
wait_run() { # event, since, [sha]
  local event="$1" since="$2" sha="${3:-}" tries=0
  RUN_ID=""
  while [ -z "$RUN_ID" ] && [ "$tries" -lt 60 ]; do
    [ "$tries" = 0 ] || sleep 5
    tries=$((tries + 1))
    RUN_ID="$(gh run list -R "$REPO" ${sha:+--commit "$sha"} --event "$event" -L 20 --json databaseId,createdAt \
      | jq -r --arg t "$since" '[.[] | select(.createdAt >= $t)] | sort_by(.createdAt) | last | .databaseId // empty')"
  done
  [ -n "$RUN_ID" ] || fail "no $event run started${sha:+ on ${sha:0:8}}"
  log "run $RUN_ID ($event${sha:+ on ${sha:0:8}})…"
  gh run watch "$RUN_ID" -R "$REPO" --interval 10 >"$DIR/logs/watch-$RUN_ID.log" 2>&1 || true
  read -r RUN_CONCLUSION RUN_URL < <(gh run view "$RUN_ID" -R "$REPO" --json conclusion,url -q '"\(.conclusion) \(.url)"')
  log "run $RUN_ID: $RUN_CONCLUSION"
}

# A view is a page a step leaves for `shot`: its URL, and optionally the CSS
# selector of the element the picture starts at, a regex its text matches,
# a height (a number, or "fit" for the element's own height) and the text of
# a button to click first. The fields are split by the unit separator, since
# a regex can hold a tab or a bar.
record_view() { # name, url, [selector], [regex], [height], [click]
  printf '%s\037%s\037%s\037%s\037%s\n' "$2" "${3:-}" "${4:-}" "${5:-900}" "${6:-}" > "$DIR/views/$1"
  log "view $1: $2"
}

# A job's log, as text: GitHub shows job logs only to a signed-in reader, so
# the logged-out picture of a job page lists its steps, and this is the log.
save_job_log() { # job id, name
  gh run view -R "$REPO" --job "$1" --log 2>/dev/null \
    | cut -f3- | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //; s/\x1b\[[0-9;]*m//g' > "$DIR/logs/$2.log" || true
  log "log $2: $DIR/logs/$2.log"
}

# The lines a stopped wave leaves for the reader: the approve command, or why
# it was refused.
held_lines() { # log file
  grep -E 'chant approve tf-apply wave-|changed after it was approved|planned differently since' "$1" | sort -u || true
}

pr_for() { # scenario, state -> prints the pull request number
  gh pr list -R "$REPO" --head "change/$1" --state "$2" --json number -q '.[0].number // empty'
}

# The run's first failed job: the wave that stopped.
stopped_job() { # run id -> "job-id<TAB>job-name"
  gh run view "$1" -R "$REPO" --json jobs -q '[.jobs[] | select(.conclusion == "failure")][0] | "\(.databaseId)\t\(.name)"'
}

# ── the signer ───────────────────────────────────────────────────────────────

KEY="$DIR/signer"

new_key() {
  rm -f "$KEY" "$KEY.pub"
  ssh-keygen -q -t ed25519 -N "" -C "$SIGNER" -f "$KEY"
  chmod 600 "$KEY"
  log "made this run's signer key in $DIR"
}

# List this run's key on main, in place of any key an earlier run listed. The
# commit skips CI: it changes no root.
ensure_signer() {
  [ -f "$KEY" ] || new_key
  local line tree="$WORK/signer" sha
  line="$SIGNER $(cut -d' ' -f1,2 "$KEY.pub")"
  clone_main "$tree"
  if grep -qxF "$line" "$tree/.chant/allowed_signers" 2>/dev/null; then return 0; fi
  mkdir -p "$tree/.chant"
  { grep -v "^$SIGNER " "$tree/.chant/allowed_signers" 2>/dev/null || true; echo "$line"; } > "$WORK/signers"
  mv "$WORK/signers" "$tree/.chant/allowed_signers"
  commit "$tree" "List this sandbox run's signer in .chant/allowed_signers [skip ci]"
  sha="$(push "$tree" main)"
  log "listed this run's signer key on main at ${sha:0:8}"
}

# After a green apply on main: the state the apply left, committed to main.
# The commit skips CI; the next push plans against it.
record_state() {
  local tree="$WORK/state" sha
  clone_main "$tree"
  apply_state "$tree"
  if [ -z "$(git -C "$tree" status --porcelain)" ]; then log "the state on main is current"; return 0; fi
  commit "$tree" "Record the state the apply left [skip ci]"
  sha="$(push "$tree" main)"
  log "recorded the state on main at ${sha:0:8}"
}

# The default branch requires terragucci/plan, as the docs' add-to page asks,
# through a ruleset: unlike a classic protection rule, a logged-out reader can
# open it, so it can be screenshotted. Repository admins (the script's token)
# may bypass it, so reset and the state commits still push to main.
RULESET="terragucci/plan required"
ensure_ruleset() {
  local id
  id="$(gh api "repos/$REPO/rulesets" -q ".[] | select(.name == \"$RULESET\") | .id")"
  if [ -z "$id" ]; then
    id="$(jq -n --arg name "$RULESET" '{name: $name, target: "branch", enforcement: "active",
      conditions: {ref_name: {include: ["~DEFAULT_BRANCH"], exclude: []}},
      bypass_actors: [{actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}],
      rules: [{type: "required_status_checks", parameters: {strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false, required_status_checks: [{context: "terragucci/plan"}]}}]}' \
      | gh api -X POST "repos/$REPO/rulesets" --input - -q .id)" || fail "could not add the ruleset"
    log "main requires terragucci/plan (ruleset $id)"
  fi
  record_view required "$WEB/rules/$id" "" "" 900 "Show additional settings"
}

# ── commands ─────────────────────────────────────────────────────────────────

close_and_prune() {
  local n b
  for n in $(gh pr list -R "$REPO" --state open --json number -q '.[].number'); do
    gh pr close "$n" -R "$REPO" >/dev/null && log "closed pull request $n"
  done
  for n in $(gh issue list -R "$REPO" --state open --json number -q '.[].number'); do
    gh issue close "$n" -R "$REPO" >/dev/null && log "closed issue $n"
  done
  for n in $(gh run list -R "$REPO" -L 50 --json databaseId,status -q '.[] | select(.status != "completed") | .databaseId'); do
    gh run cancel "$n" -R "$REPO" >/dev/null 2>&1 || true
  done
  for b in $(gh api "repos/$REPO/branches?per_page=100" -q '.[].name' | grep -vx main || true); do
    gh api -X DELETE "repos/$REPO/git/refs/heads/$b" >/dev/null && log "deleted branch $b"
  done
}

case "$CMD" in
  up)
    fresh=""
    for a in "$@"; do case "$a" in --fresh) fresh=1 ;; *) fail "unknown flag '$a' (--fresh)" ;; esac; done
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then fail "up needs Docker, to write the roots' state"; fi
    if [ -z "$fresh" ] && [ "$(gh repo view "$REPO" --json isEmpty -q .isEmpty)" = false ]; then
      log "$REPO already has its first commit; 'just sandbox reset' goes back to it, 'up --fresh' replaces it"
    else
      [ -z "$fresh" ] || close_and_prune
      build_main "$WORK/tree"
      since="$(now)"
      # Fixed dates: the same tree gives the same first commit every time.
      GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" \
        commit "$WORK/tree" "The shop's estate, plan-only"
      sha="$(push "$WORK/tree" main --force)"
      gh api -X PATCH "repos/$REPO" -f default_branch=main >/dev/null
      log "pushed the first commit ${sha:0:8}; the pipeline applies every root"
      wait_run push "$since" "$sha"
      record_view run "$RUN_URL"
      [ "$RUN_CONCLUSION" = success ] || fail "the first run ended $RUN_CONCLUSION: $RUN_URL"
    fi
    ensure_ruleset
    new_key
    printf '\n  Sandbox  %s\n  Next     just sandbox change one-root\n' "$WEB"
    ;;

  change)
    name="${1:-}"; title="$(title_of "$name")"
    patch="$(scenario_patch "$name")"
    clone_main "$WORK/tree"
    git -C "$WORK/tree" checkout -q -b "change/$name"
    git -C "$WORK/tree" apply -p1 "$patch" || fail "$name does not apply to main; run 'just sandbox reset' first"
    commit "$WORK/tree" "$title"
    since="$(now)"
    sha="$(push "$WORK/tree" "change/$name" --force)"
    pr="$(pr_for "$name" open)"
    if [ -z "$pr" ]; then
      gh pr create -R "$REPO" --head "change/$name" --base main --title "$title" \
        --body "A scenario from the terragucci example (example/changes/$name.patch), plan-only." >/dev/null
      pr="$(pr_for "$name" open)"
    fi
    log "pull request $pr for change/$name at ${sha:0:8}"
    # The pull request's run posts the plan note; the push's run checks the format.
    wait_run pull_request "$since" "$sha"
    plan_url="$RUN_URL" plan_status="$RUN_CONCLUSION"
    record_view plan-run "$RUN_URL"
    wait_run push "$since" "$sha"
    # The push's run: a failed check marks its job. The picture ends below the
    # job graph.
    record_view check "$RUN_URL" "" "" 640
    if [ "$RUN_CONCLUSION" = failure ]; then
      IFS=$'\t' read -r job _ < <(stopped_job "$RUN_ID")
      [ -z "${job:-}" ] || save_job_log "$job" check
    fi
    record_view note "$WEB/pull/$pr" ".timeline-comment" "terragucci tf-plan" fit
    # Logged out, a pull request shows no merge box; its Checks tab lists the runs.
    record_view checks "$WEB/pull/$pr/checks"
    printf '\n  Pull request  %s/pull/%s (the plan note is in its conversation)\n  Plan          %s (%s)\n  Check         %s (%s)\n' \
      "$WEB" "$pr" "$plan_url" "$plan_status" "$RUN_URL" "$RUN_CONCLUSION"
    ;;

  merge)
    name="${1:-}"; title_of "$name" >/dev/null
    pr="$(pr_for "$name" open)"
    [ -n "$pr" ] || fail "no open pull request for change/$name; run 'just sandbox change $name' first"
    ensure_signer
    since="$(now)"
    # --admin: the ruleset lets the sandbox's admin merge whatever the plan said.
    gh pr merge "$pr" -R "$REPO" --squash --admin --delete-branch >/dev/null 2>&1 || gh pr merge "$pr" -R "$REPO" --squash --admin >/dev/null \
      || fail "could not merge pull request $pr"
    sha="$(gh pr view "$pr" -R "$REPO" --json mergeCommit -q .mergeCommit.oid)"
    log "merged pull request $pr into main at ${sha:0:8}"
    wait_run push "$since" "$sha"
    record_view merged "$RUN_URL"
    printf '\n  Merged    pull request %s into main\n  Pipeline  %s (%s)\n' "$pr" "$RUN_URL" "$RUN_CONCLUSION"
    if [ "$RUN_CONCLUSION" = success ]; then
      record_state
    else
      IFS=$'\t' read -r job job_name < <(stopped_job "$RUN_ID")
      [ -n "${job:-}" ] || fail "the run ended $RUN_CONCLUSION with no failed job"
      save_job_log "$job" "$RUN_ID-$job"
      lines="$(held_lines "$DIR/logs/$RUN_ID-$job.log")"
      # A refusal also prints the approve command for the new plan.
      if grep -qE 'changed after it was approved|planned differently since' <<<"$lines"; then view=refused; else view=waiting; fi
      cp "$DIR/logs/$RUN_ID-$job.log" "$DIR/logs/$view.log"
      record_view "$view" "$WEB/actions/runs/$RUN_ID/job/$job"
      record_view "$view-run" "$RUN_URL" "" "" 640
      # The run, and the wave and plan digest its approve command names.
      printf '%s\t%s\t%s\n' "$RUN_ID" \
        "$(grep -o 'chant approve tf-apply wave-[0-9]*' <<<"$lines" | head -1 | sed 's/.* //')" \
        "$(grep -o -- '--plan [^ ]*' <<<"$lines" | head -1 | sed 's/^--plan //')" > "$DIR/waiting"
      printf '  Stopped   %s\n' "$job_name"
      while read -r l; do printf '  %s\n' "$l"; done <<<"$lines"
    fi
    ;;

  approve)
    wave="" hold=""
    for a in "$@"; do case "$a" in --hold) hold=1 ;; wave-*) wave="$a" ;; *) fail "unknown argument '$a' (wave-N, --hold)" ;; esac; done
    [ -f "$DIR/waiting" ] || fail "no wave is waiting; run 'just sandbox change destroy' and 'just sandbox merge destroy' first"
    IFS=$'\t' read -r run waiting digest < "$DIR/waiting"
    # The digest binds the approval to the plans the run printed; another wave
    # named on the command line binds whatever it has pending.
    [ -z "$wave" ] || [ "$wave" = "$waiting" ] || digest=""
    wave="${wave:-$waiting}"
    [ -n "$wave" ] || fail "the last stopped run asked for no approval"
    [ -f "$KEY" ] || fail "no signer key in $DIR; merge a scenario first"
    chant="$HERE/../node_modules/.bin/chant"
    [ -x "$chant" ] || fail "no chant in node_modules; run 'npm ci'"
    git clone -q --no-single-branch "$GIT_URL" "$WORK/approve" || fail "could not clone $REPO"
    git -C "$WORK/approve" config user.name "$SIGNER"
    git -C "$WORK/approve" config user.email "$SIGNER@terragucci.local"
    git -C "$WORK/approve" config commit.gpgsign false
    out="$(cd "$WORK/approve" && "$chant" approve tf-apply "$wave" ${digest:+--plan "$digest"} --actor "$SIGNER" --sign "$KEY" 2>&1)" \
      || { echo "$out" >&2; fail "chant approve tf-apply $wave failed"; }
    printf '%s\n' "$out" > "$DIR/logs/approve.log"
    printf '\n  Approved  %s, signed as %s\n' "$wave" "$SIGNER"
    [ -z "$hold" ] || exit 0
    # Run the stage again: re-running the stopped jobs applies the approved wave
    # and the waves after it.
    since="$(now)"
    gh run rerun "$run" -R "$REPO" --failed >/dev/null || fail "could not re-run run $run"
    sleep 10
    log "run $run again…"
    gh run watch "$run" -R "$REPO" --interval 10 >"$DIR/logs/watch-$run-again.log" 2>&1 || true
    read -r conclusion url < <(gh run view "$run" -R "$REPO" --json conclusion,url -q '"\(.conclusion) \(.url)"')
    record_view applied "$url"
    job="$(gh run view "$run" -R "$REPO" --json jobs -q "[.jobs[] | select(.name | startswith(\"apply-$wave\"))][0].databaseId // empty")"
    if [ -n "$job" ]; then
      save_job_log "$job" applied
      record_view applied-job "$WEB/actions/runs/$run/job/$job"
    fi
    rm -f "$DIR/waiting"
    printf '  Pipeline  %s (%s)\n' "$url" "$conclusion"
    [ "$conclusion" = success ] || fail "the run ended $conclusion after the approval"
    record_state
    ;;

  plan-comment)
    name="${1:-}"
    if [ -n "$name" ]; then pr="$(pr_for "$name" open)"; else pr="$(gh pr list -R "$REPO" --state open -L 1 --json number -q '.[0].number // empty')"; fi
    [ -n "$pr" ] || fail "no open pull request; run 'just sandbox change one-root' first"
    since="$(now)"
    gh pr comment "$pr" -R "$REPO" --body "/terragucci plan" >/dev/null
    log "commented /terragucci plan on pull request $pr"
    wait_run issue_comment "$since"
    record_view replan-run "$RUN_URL"
    # The re-plan edits the note in place; the picture ends below the comment.
    record_view reply "$WEB/pull/$pr" ".timeline-comment" "terragucci tf-plan" 664
    printf '\n  Pull request  %s/pull/%s (the reply is in its conversation)\n  Re-plan       %s (%s)\n' "$WEB" "$pr" "$RUN_URL" "$RUN_CONCLUSION"
    ;;

  drift)
    # terraform_data reads nothing back, so a refresh finds no drift in it. A
    # local_file reads its file: staging orders keeps one, written by the state
    # apply, and deleting it is the example's queue deleted in the console.
    root=envs/staging/orders
    clone_main "$WORK/tree"
    if [ ! -f "$WORK/tree/$root/drift.tf" ]; then
      cat > "$WORK/tree/$root/drift.tf" <<'EOF'
# The sandbox's drift scenario: a file standing in for the jobs queue, which
# stack/sandbox-github.sh drift deletes outside the code.
resource "local_file" "jobs_queue" {
  filename = "${path.module}/jobs-queue.txt"
  content  = "shop-staging-orders-jobs\n"
}
EOF
      apply_state "$WORK/tree"
      commit "$WORK/tree" "Keep staging orders' jobs queue as a file the drift scenario can delete [skip ci]"
      push "$WORK/tree" main >/dev/null
    fi
    git -C "$WORK/tree" rm -q "$root/jobs-queue.txt"
    commit "$WORK/tree" "Delete staging orders' jobs queue outside the code [skip ci]"
    push "$WORK/tree" main >/dev/null
    log "deleted $root/jobs-queue.txt on main, outside the code"
    since="$(now)"
    gh workflow run terragucci.yml -R "$REPO" --ref main >/dev/null || fail "could not start the drift job"
    wait_run workflow_dispatch "$since"
    record_view drift-run "$RUN_URL"
    issue="$(gh issue list -R "$REPO" --state open -L 1 --json number -q '.[0].number // empty')"
    [ -n "$issue" ] || fail "the drift run ($RUN_CONCLUSION) opened no issue: $RUN_URL"
    record_view drift "$WEB/issues/$issue" "" "" 1100
    printf '\n  Drift run  %s (%s)\n  Issue      %s/issues/%s\n' "$RUN_URL" "$RUN_CONCLUSION" "$WEB" "$issue"
    ;;

  capture)
    # Each step runs as its own command, so what it prints is what a reader of
    # the docs would see, and each view is shot right after its step: the
    # re-plan edits the note the `note` view shows.
    ROOT="$(cd "$HERE/.." && pwd)"
    DATA="$ROOT/docs-site/src/data/tutorial" SHOTS="$ROOT/docs-site/src/assets/tutorial"
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then fail "capture needs Docker, for the state and the screenshots"; fi
    started="$(date +%s)"
    "$0" reset
    ensure_ruleset
    : > "$WORK/commands"
    step() { # command words...
      local out rc=0
      out="$("$0" "$@")" || rc=$?
      [ "$rc" = 0 ] || return "$rc"
      jq -n --arg cmd "just sandbox $*" --arg output "$(sed '/^$/d; s/^  //' <<<"$out")" '{cmd: $cmd, output: $output, exit: 0}' >> "$WORK/commands"
    }
    # A job's log, which a logged-out reader cannot open: its lines from the
    # first that matches one regex to the first after it that matches another.
    log_lines() { # command, log file, from regex, to regex
      local out
      out="$(awk -v a="$3" -v b="$4" '!on && $0 ~ a { on = 1 } on { sub(/^##\[error\]/, ""); sub(/[ \t]+$/, ""); print } on && $0 ~ b { exit }' "$2")"
      [ -n "$out" ] || fail "no lines from /$3/ in $2"
      jq -n --arg cmd "$1" --arg output "$out" '{cmd: $cmd, output: $output, exit: 3}' >> "$WORK/commands"
    }
    take() { # view...
      local v
      for v in "$@"; do "$0" shot "$v"; done
    }
    pairs="required:required note:note reply:reply check:check waiting-run:waiting"
    take required
    step change one-root || fail "change one-root failed"
    take note
    step plan-comment one-root || fail "plan-comment one-root failed"
    take reply
    step change unformatted || fail "change unformatted failed"
    take check
    log_lines "gh run view --log-failed  # the check job of change/unformatted" "$DIR/logs/check.log" '^envs/.*[.]tf$' 'Process completed'
    step change destroy || fail "change destroy failed"
    step merge destroy || fail "merge destroy failed"
    take waiting-run
    log_lines "gh run view --log-failed  # wave 4 on main" "$DIR/logs/waiting.log" '^wave [0-9]+ of [0-9]+:' 'Process completed'
    # Drift comes last: the file it deletes would be planned back by any later
    # merge. A release whose drift job cannot keep its issue on github.com
    # leaves the drift view out, and any committed one stands.
    if step drift; then
      take drift
      pairs="$pairs drift:drift"
    else
      log "no drift issue on $RELEASE; the drift view is left as it was"
    fi
    # The files the docs use: step `github`, beside the Forgejo steps.
    hash="$(cd "$ROOT" && find example -type f ! -path '*/.terraform/*' | LC_ALL=C sort | while read -r f; do
      printf '%s\0' "$f"; cat "$f"; done | shasum -a 256 | cut -c1-16)"
    # A view this run left out keeps the hash the last capture recorded.
    shots="$(jq -c '.shots // {}' "$DATA/github.json" 2>/dev/null || echo '{}')"
    for pair in $pairs; do
      from="${pair%%:*}" to="${pair#*:}"
      for scheme in light dark; do
        cp "$DIR/shots/$from-$scheme.png" "$SHOTS/github-$to-$scheme.png"
        h="$(shasum -a 256 "$SHOTS/github-$to-$scheme.png" | cut -c1-16)"
        shots="$(jq --arg k "$to-$scheme" --arg h "$h" '. + {($k): $h}' <<<"$shots")"
      done
    done
    jq -s --arg h "$hash" --argjson shots "$shots" '{step: "github", source_hash: $h, commands: ., shots: $shots}' \
      "$WORK/commands" > "$DATA/github.json"
    "$0" reset
    printf '\n  Wrote  docs-site/src/data/tutorial/github.json and docs-site/src/assets/tutorial/github-*.png\n  Took   %s minutes\n' \
      "$(( ($(date +%s) - started + 59) / 60 ))"
    ;;

  reset)
    close_and_prune
    clone_main "$WORK/tree"
    first="$(git -C "$WORK/tree" rev-list --max-parents=0 HEAD | tail -1)"
    if [ "$(git -C "$WORK/tree" rev-parse HEAD)" != "$first" ]; then
      git -C "$WORK/tree" checkout -q "$first"
      since="$(now)"
      push "$WORK/tree" main --force >/dev/null
      # Moving main back is a push; its run would only re-apply what the state
      # says. GitHub can take a while to start it, so wait for it, then cancel.
      for _ in $(seq 1 12); do
        sleep 5
        n="$(gh run list -R "$REPO" --commit "$first" --event push -L 5 --json databaseId,createdAt,status \
          | jq -r --arg t "$since" '[.[] | select(.createdAt >= $t and .status != "completed")][0].databaseId // empty')"
        [ -z "$n" ] || { gh run cancel "$n" -R "$REPO" >/dev/null 2>&1 || true; log "cancelled run $n, the push of main back"; break; }
      done
    fi
    rm -f "$DIR/waiting" "$DIR"/views/*
    new_key
    log "main is back at its first commit ${first:0:8}"
    ;;

  shot)
    view="${1:-}"
    [ -n "$view" ] || fail "usage: sandbox-github.sh shot <view>|all|list"
    if [ "$view" = list ]; then
      for f in "$DIR"/views/*; do [ -f "$f" ] && printf '%-12s %s\n' "$(basename "$f")" "$(cut -d$'\037' -f1 "$f")"; done
      exit 0
    fi
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then fail "shot needs Docker, to run Chromium"; fi
    if [ "$view" = all ]; then views=("$DIR"/views/*); else views=("$DIR/views/$view"); fi
    for f in "${views[@]}"; do
      [ -f "$f" ] || fail "no view '$(basename "$f")'; 'shot list' names them"
      name="$(basename "$f")"
      IFS=$'\037' read -r url scroll match height click < "$f"
      for scheme in light dark; do
        hooks=()
        [ -z "$click" ] || hooks+=(--click "$click")
        [ -z "$scroll" ] || hooks+=(--scroll "$scroll")
        [ -z "$match" ] || hooks+=(--match "$match")
        if [ "$height" = fit ]; then hooks+=(--fit 1); height=900; fi
        # A fresh profile in a container: the page as a logged-out reader sees it.
        docker run --rm --ipc=host -v "$HERE/shot.mjs:/shot/shot.mjs:ro" -v "$DIR/shots:/out" "$SHOT_IMAGE" sh -c '
          chrome="$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome | head -1)"
          printf "#!/bin/sh\nexec %s --no-sandbox \"\$@\"\n" "$chrome" > /tmp/chrome && chmod +x /tmp/chrome
          exec node /shot/shot.mjs --chrome /tmp/chrome "$@"' sh \
          --url "$url" --out "/out/$name-$scheme.png" --width 1280 --height "$height" --scheme "$scheme" "${hooks[@]}" \
          || fail "no screenshot of $url"
        log "shot $DIR/shots/$name-$scheme.png"
      done
    done
    ;;

  minutes)
    since="${1:-1970-01-01T00:00:00Z}"
    total=0 runs=0
    for id in $(gh run list -R "$REPO" -L 500 --json databaseId,createdAt -q ".[] | select(.createdAt >= \"$since\") | .databaseId"); do
      ms="$(gh api "repos/$REPO/actions/runs/$id/timing" -q '.run_duration_ms // 0' 2>/dev/null || echo 0)"
      total=$((total + ms)); runs=$((runs + 1))
    done
    printf '%s runs since %s, %s minutes of run time (a public repo on GitHub-hosted runners bills none)\n' \
      "$runs" "$since" "$(( (total + 59999) / 60000 ))"
    ;;
esac
