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
#                                     unformatted, orders-note, refuse, or oidc
#                                     and override once prove has set main up)
#                                     and wait for its plan
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
#   stack/sandbox-github.sh prove [merge|pull-request|modules] [--record FILE]
#                                     from a reset sandbox, each phase (merge
#                                     when none is named) sets main up
#                                     for its claims and runs them, and the
#                                     sandbox is reset after each; prints a
#                                     verdict per claim; --record merges them
#                                     into FILE (docs-site/src/data/validation.json)
#   stack/sandbox-github.sh reset          close the pull requests and issues,
#                                     delete every other branch, every tag and
#                                     every secret, and put main back to its
#                                     first commit
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
RELEASE="${TERRAGUCCI_SANDBOX_RELEASE:-0.4.1}"
# The container stack/shot.mjs runs in: Node 22 and Chromium.
SHOT_IMAGE="${TERRAGUCCI_SHOT_IMAGE:-mcr.microsoft.com/playwright:v1.55.0-noble}"
SIGNER="sandbox-signer"
# 1: the sandbox's terragucci.yml marks the checkout safe for git (build_main).
SAFE_DIRECTORY="${TERRAGUCCI_SANDBOX_SAFE_DIRECTORY:-0}"
WEB="https://github.com/$REPO"

log()  { echo "[sandbox] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

usage() { sed -n '3,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; }
case "$CMD" in up|change|merge|approve|plan-comment|drift|capture|prove|reset|shot|minutes) ;; *) usage; exit 2 ;; esac

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
    oidc) echo "Plan and apply the OIDC probe again" ;;
    orders-note) echo "Say who owns dev orders" ;;
    override) echo "Send the OIDC probe out under a policy override" ;;
    refuse) echo "Stop keeping records for staging payments" ;;
    *) fail "unknown scenario '$1' (one-root, module-bump, destroy, replace, unformatted, oidc, orders-note, override, refuse)" ;;
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
  echo "$RUN_ID" > "$DIR/last-run"
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
  gh run view "$1" -R "$REPO" --json jobs -q '[.jobs[] | select(.conclusion == "failure" and .name != "explain-refusal")][0] | "\(.databaseId)\t\(.name)"'
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
  local line tree sha
  tree="$(mktemp -d "$WORK/signer.XXXXXX")"
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
  local tree sha
  tree="$(mktemp -d "$WORK/state.XXXXXX")"
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

# ── the claims prove runs ────────────────────────────────────────────────────

# What `prove` turns on at main, on top of the first commit: locks from the
# first plan, a policy that denies a replacement, and OIDC roles for the plan
# and apply jobs. The roles are names only: the sandbox has no cloud account,
# so the probe root below checks the token each job holds and trades it with
# nothing.
PROBE=envs/dev/oidc
PLAN_ROLE=arn:aws:iam::000000000000:role/terragucci-sandbox-plan
APPLY_ROLE=arn:aws:iam::000000000000:role/terragucci-sandbox-apply
DENIAL="would be replaced, and a replaced table starts empty"
# The probe input the second policy rule holds for an override, the principal
# policy.override lists, and one it does not (the signers file lists both).
HELD="held-for-an-override"
STRANGER=sandbox-stranger
HOLD="is held until someone policy.override lists lets it through"
# The secret the agent comment's push job reads: this run's token, set by
# prove and deleted by reset.
AGENT_SECRET=SANDBOX_AGENT_TOKEN

# forge|claim|what it shows, as the validation page lists them.
PROVE_CLAIMS='github.com|affected|a pull request that changes one root plans that root alone, and its plan note covers it alone
github.com|comment-plan|/terragucci plan on a pull request re-plans it in a run of its own, and the re-plan edits the plan note
github.com|pr-lock|with locks: plan a pull request locks the root it plans, and a second one reaching that root fails terragucci/lock and is answered with the root and the holder
github.com|policy|a pull request that replaces a table fails terragucci/plan under the Rego policy on main, and its plan note names the denial
github.com|oidc|the plan job holds a GitHub-signed OIDC token for this repo and run, for the plan role, and the apply job on main one for the apply role; with no cloud account the token is checked, not traded with STS
github.com|gate-wait|a merged destroy stops its wave with the approve command, and after a sealed chant approve the re-run applies it
github.com|note-footer|the plan note ends with the terragucci footer, and its taco image answers 200 with a PNG
github.com|tips|the plan note counts the tips the run report holds, and each tip in the report names its rule and its page
github.com|comment-agent|a /terragucci agent comment pushes the commit of the stand-in agent onto the branch of the pull request, which plans again, and the reply links it; an ask whose change touches the pipeline is refused and nothing is pushed
github.com|comment-apply|/terragucci apply on a merged pull request applies it again from its merge commit, and while its wave waits it applies nothing and gives the approve command; on an open pull request it is refused
github.com|policy-override|a wave the policy denies applies once the approver policy.override lists overrides its plan with terragucci override, and the report names the override; an override by someone it does not list counts for nothing
github.com|apply-serial|two merges pushed back to back apply one at a time in the order they arrived, none is cancelled, and each commit ends with a terragucci/apply success
github.com|explain-refusal|after a refused wave the explain-refusal job of the refused-wave guide runs, and its respond wave-refused step names the root that moved; a stand-in takes the place of the model step
github.com|approve-command|terragucci approve in a clone approves the waiting wave with no digest copied, and the re-run applies it; with --dry-run it records nothing
github.com|pr-apply-lock|with apply.when: pull-request a second pull request that reaches a root an open one applied is refused with the root and the holder named, and applies once the first is unlocked with /terragucci unlock
github.com|pr-apply-stale|a comment on an approved pull request whose head is behind main is refused as not up to date, and nothing applies
github.com|pr-apply|with apply.merge: auto a comment on an open, approved pull request applies its head in every wave, and pr-merge merges it with the job token
github.com|pr-apply-token|with apply.merge: auto and merge_token_env the merge is made with that token, so the merge commit starts its own run on main
github.com|publish|with modules.publish: git-tags a conventional commit to a module on main makes the publish job push the module tag
github.com|rollout|once the roots pin that tag and the next version is published, terragucci rollout --mode apply opens one pull request for the canary wave that moves those pins alone
github.com|drift-issue|the drift job opens the drift issue, a second run updates that issue, and a run that finds no drift closes it'

OVERRIDE_LOCAL='# The sandbox keeps this root'"'"'s state in the repo, beside its code.
terraform {
  backend "local" {}
}
'

# The probe root: a data source whose program checks the job's token and
# writes what it found to terragucci-report/oidc-<plan|apply>.json, which the
# job keeps in its report artifact.
probe_root() { # dir
  mkdir -p "$1/$PROBE"
  cat > "$1/$PROBE/main.tf" <<'TF'
# The sandbox's OIDC probe. Each plan of this root runs probe.mjs, which checks
# the token terragucci requested for the job's AWS role and writes what it
# found beside the job's report. The sandbox has no cloud account, so nothing
# trades the token with STS.
terraform {
  required_version = "~> 1.13.0"

  required_providers {
    external = {
      source  = "hashicorp/external"
      version = "2.3.5"
    }
  }
}

provider "external" {}

data "external" "oidc" {
  program = ["node", "${path.module}/probe.mjs"]
}

resource "terraform_data" "rev" {
  input = trimspace(file("${path.module}/rev.txt"))
}

output "oidc" {
  value = data.external.oidc.result
}
TF
  printf '%s' "$OVERRIDE_LOCAL" > "$1/$PROBE/state_override.tf"
  echo first > "$1/$PROBE/rev.txt"
  cat > "$1/$PROBE/probe.mjs" <<'JS'
// In a GitHub job: the token in AWS_WEB_IDENTITY_TOKEN_FILE must verify against
// GitHub's published keys and name this repo, run, commit and event, with the
// audience AWS reads, and the job's role must be the one its kind gets (plan
// or apply). What it found goes to terragucci-report/oidc-<plan|apply>.json,
// which the job keeps as an artifact. Outside a job (the script's own state
// apply) it checks nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { resolve } from "node:path";
const e = process.env;
if (e.GITHUB_ACTIONS !== "true") { console.log(JSON.stringify({ job: "none" })); process.exit(0); }
const kind = (e.AWS_ROLE_SESSION_NAME || "none").replace(/^terragucci-/, "");
const out = resolve(e.GITHUB_WORKSPACE || "../../..", "terragucci-report");
const found = { kind, event: e.GITHUB_EVENT_NAME, run_id: e.GITHUB_RUN_ID, problems: [] };
const done = (code) => {
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, `oidc-${kind}.json`), JSON.stringify(found, null, 2) + "\n");
  if (code) { console.error("oidc probe: " + found.problems.join("; ")); process.exit(code); }
  console.log(JSON.stringify({ sub: found.sub, role: found.role }));
  process.exit(0);
};
if (!e.AWS_WEB_IDENTITY_TOKEN_FILE || !e.AWS_ROLE_ARN) { found.problems.push("no AWS_WEB_IDENTITY_TOKEN_FILE or AWS_ROLE_ARN, so the job took no role"); done(1); }
const [h, p, s] = readFileSync(e.AWS_WEB_IDENTITY_TOKEN_FILE, "utf8").trim().split(".");
if (!s) { found.problems.push("the token file holds no JWT"); done(1); }
const dec = (x) => JSON.parse(Buffer.from(x, "base64url").toString());
const head = dec(h), c = dec(p);
const ISS = "https://token.actions.githubusercontent.com";
const conf = await (await fetch(ISS + "/.well-known/openid-configuration")).json();
const jwk = (await (await fetch(conf.jwks_uri)).json()).keys.find((k) => k.kid === head.kid);
found.verified = head.alg === "RS256" && !!jwk
  && verify("sha256", Buffer.from(h + "." + p), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
if (!found.verified) found.problems.push(`the signature (${head.alg}, kid ${head.kid}) does not verify against ${conf.jwks_uri}`);
// The subject names the repo by name, or by name@id where the owner asks for
// immutable subjects.
const [owner, name] = e.GITHUB_REPOSITORY.split("/");
const what = e.GITHUB_EVENT_NAME === "pull_request" ? "pull_request" : "ref:" + e.GITHUB_REF;
const subs = [`repo:${owner}/${name}:${what}`, `repo:${owner}@${e.GITHUB_REPOSITORY_OWNER_ID}/${name}@${e.GITHUB_REPOSITORY_ID}:${what}`];
if (!subs.includes(c.sub)) found.problems.push(`sub is ${c.sub}, not ${subs.join(" or ")}`);
const want = { iss: ISS, aud: "sts.amazonaws.com", repository: e.GITHUB_REPOSITORY, repository_id: e.GITHUB_REPOSITORY_ID, run_id: e.GITHUB_RUN_ID, sha: e.GITHUB_SHA, event_name: e.GITHUB_EVENT_NAME };
for (const [k, v] of Object.entries(want)) if (String(c[k]) !== String(v)) found.problems.push(`${k} is ${c[k]}, not ${v}`);
found.role = e.AWS_ROLE_ARN.split("/").pop();
// The drift job plans, so it holds the plan role.
if (found.role !== "terragucci-sandbox-" + (kind === "drift" ? "plan" : kind)) found.problems.push(`a ${kind} job holds ${found.role}`);
Object.assign(found, { iss: c.iss, aud: c.aud, sub: c.sub, sha: c.sha });
done(found.problems.length ? 1 : 0);
JS
}

# main as prove needs it: the config, the policy and the probe root, the
# pipeline init writes from them, and the state. The commit skips CI.
prove_main() {
  local tree="$WORK/prove-main" sha
  clone_main "$tree"
  cat >> "$tree/terragucci.yml" <<YML
# Set by stack/sandbox-github.sh prove; reset takes it away.
locks: plan
policy:
  engine: conftest
  path: policy
  override: [$SIGNER]
oidc:
  plan_role: $PLAN_ROLE
  apply_role: $APPLY_ROLE
agent:
  via: forge
  token_env: $AGENT_SECRET
  comment:
    command: sh .agent/stand-in.sh
    timeout: 10
YML
  mkdir -p "$tree/policy"
  cat > "$tree/policy/replace.rego" <<REGO
package main

import rego.v1

# A replaced table, queue or bucket comes back empty.
deny contains msg if {
	some rc in input.resource_changes
	"delete" in rc.change.actions
	"create" in rc.change.actions
	msg := sprintf("%s $DENIAL", [rc.address])
}

# The OIDC probe's input, set to this value, waits for an override.
deny contains msg if {
	some rc in input.resource_changes
	rc.type == "terraform_data"
	"update" in rc.change.actions
	rc.change.after.input == "$HELD"
	msg := sprintf("%s $HOLD", [rc.address])
}
REGO
  probe_root "$tree"
  # A stand-in agent for the /terragucci agent comment: no model, one edit.
  mkdir -p "$tree/.agent"
  cat > "$tree/.agent/stand-in.sh" <<'SH'
#!/bin/sh
# The sandbox's stand-in agent: the prompt comes on stdin, and it makes one
# edit with no model. An ask that says "touch ci" also edits the pipeline,
# which terragucci must refuse to push.
ask="$(sed -n '/^<ask>$/,/^<\/ask>$/p')"
echo "stand-in agent asked: $ask"
printf '\n# The orders team is on call for this root.\n' >> envs/dev/orders/main.tf
case "$ask" in
  *"touch ci"*) echo "# the stand-in agent was here" >> .github/workflows/terragucci.yml ;;
esac
SH
  # Both principals sign with this run's key; policy.override lists one.
  mkdir -p "$tree/.chant"
  printf '%s %s\n%s %s\n' "$SIGNER" "$(cut -d' ' -f1,2 "$KEY.pub")" "$STRANGER" "$(cut -d' ' -f1,2 "$KEY.pub")" > "$tree/.chant/allowed_signers"
  (cd "$tree" && npx -y "@intentius/terragucci@$RELEASE" init >"$DIR/logs/prove-init.log" 2>&1) \
    || { cat "$DIR/logs/prove-init.log" >&2; fail "terragucci init failed"; }
  grep -q '^  pr-lock:' "$tree/.github/workflows/terragucci.yml" || fail "init wrote no pr-lock job"
  grep -q 'id-token: write' "$tree/.github/workflows/terragucci.yml" || fail "init asked for no OIDC token"
  grep -q '^  agent-push:' "$tree/.github/workflows/terragucci.yml" || fail "init wrote no agent-push job"
  explain_job >> "$tree/.github/workflows/terragucci.yml"
  gh secret set "$AGENT_SECRET" -R "$REPO" --body "$GH_TOKEN" >/dev/null || fail "could not set the $AGENT_SECRET secret"
  apply_state "$tree"
  commit "$tree" "Turn on plan locks, a policy with overrides, OIDC roles and the agent comment, with a root that checks each job's token [skip ci]"
  sha="$(push "$tree" main)"
  log "main at ${sha:0:8}: locks: plan, policy/replace.rego, oidc, agent, explain-refusal and $PROBE"
}

# The explain-refusal job of the agent-refused-wave guide's GitHub tab, for
# wave 4, with the release pinned. Its last step there is
# anthropics/claude-code-action, which needs a model key the sandbox does not
# have, so a stand-in prints the summary the agent would read from.
explain_job() {
  cat <<YML
  explain-refusal:
    needs: apply-wave-4
    if: failure()
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: terragucci-report-apply-wave-4, path: reports }
      - run: >
          npx -y @intentius/terragucci@$RELEASE respond wave-refused
          --approved reports/approved --current reports/current --wave 4
          --json > refusal.json
      - name: Stand-in for the agent, which reads refusal.json
        run: |
          echo "refused-wave summary:"
          jq -r .results.text refusal.json
          jq -r '"roots that moved: " + ([.results.data.roots[].root] | join(", "))' refusal.json
YML
}

head_of() { # pull request -> its head commit
  gh pr view "$1" -R "$REPO" --json headRefOid -q .headRefOid
}


# The newest status a context has on a commit, as "<state> <description>".
status_on() { # sha, context
  gh api "repos/$REPO/commits/$1/statuses?per_page=100" \
    -q "[.[] | select(.context == \"$2\")] | first | if . == null then empty else \"\(.state) \(.description)\" end" 2>/dev/null || true
}

# A status another run posts (pr-lock runs on pull_request_target), polled
# until it reaches a state or five minutes pass. Prints the last one seen.
wait_status() { # sha, context, state
  local got="" i
  for i in $(seq 1 30); do
    got="$(status_on "$1" "$2")"
    [ "${got%% *}" = "$3" ] && break
    [ "$i" = 30 ] || sleep 10
  done
  echo "$got"
}

# What the probe found in a run, from the report artifacts its jobs keep.
probe_found() { # run id, plan|apply -> the probe's JSON, empty when it wrote none
  local d="$WORK/probe-$1" f
  [ -n "$1" ] || return 0
  gh run download "$1" -R "$REPO" -D "$d" >/dev/null 2>&1 || true
  f="$(find "$d" -name "oidc-$2.json" 2>/dev/null | head -1)"
  [ -z "$f" ] || jq -c . "$f"
}

note_of() { # pull request -> the plan note's body
  gh api "repos/$REPO/issues/$1/comments?per_page=100" -q '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | first | .body // empty'
}

replies_of() { # pull request -> terragucci's replies, one per line
  gh api "repos/$REPO/issues/$1/comments?per_page=100" -q '.[] | select(.body | startswith("terragucci: ")) | .body | gsub("\n"; " ")'
}

reply_count() { # pull request -> how many replies terragucci posted on it
  gh api "repos/$REPO/issues/$1/comments?per_page=100" -q '[.[] | select(.body | startswith("terragucci: "))] | length'
}

# Comment on a pull request, wait for the run the comment starts and then for
# terragucci's reply. Prints every reply posted since the comment, oldest
# first, each on one line: another run (pr-lock's, after a push) may reply
# too. The run's id goes to $DIR/last-run. Run it in a subshell: wait_run
# fails the shell it is in.
say() { # pull request, text
  local before since i
  before="$(reply_count "$1")"; since="$(now)"
  gh pr comment "$1" -R "$REPO" --body "$2" >/dev/null || fail "could not comment on pull request $1"
  log "commented '$2' on pull request $1"
  wait_run issue_comment "$since" >&2
  for i in $(seq 1 12); do
    [ "$(reply_count "$1")" -gt "$before" ] && break
    sleep 5
  done
  gh api "repos/$REPO/issues/$1/comments?per_page=100" \
    -q '[.[] | select((.body | startswith("terragucci: ")) and .created_at >= "'"$since"'") | .body | gsub("\n"; " ")] | join(" || ")'
}

# Run a run's failed jobs again and wait for them. Prints its conclusion.
rerun() { # run id
  local i
  gh run rerun "$1" -R "$REPO" --failed >/dev/null || { echo none; return 0; }
  for i in $(seq 1 30); do
    [ "$(gh run view "$1" -R "$REPO" --json status -q .status)" != completed ] && break
    sleep 2
  done
  log "run $1 again…"
  gh run watch "$1" -R "$REPO" --interval 10 >"$DIR/logs/watch-$1-rerun.log" 2>&1 || true
  gh run view "$1" -R "$REPO" --json conclusion -q .conclusion
}

# A job of a run's latest attempt: its conclusion, or its log.
job_conclusion() { # run id, job name
  gh run view "$1" -R "$REPO" --json jobs -q "[.jobs[] | select(.name == \"$2\")][0].conclusion // \"none\"" 2>/dev/null || echo none
}
job_log() { # run id, job name -> the log file's path (empty file when there is none)
  local id
  id="$(gh run view "$1" -R "$REPO" --json jobs -q "[.jobs[] | select(.name == \"$2\")][0].databaseId // empty" 2>/dev/null || true)"
  if [ -n "$id" ]; then save_job_log "$id" "$1-$2" 2>/dev/null; else : > "$DIR/logs/$1-$2.log"; fi
  echo "$DIR/logs/$1-$2.log"
}

# One file from the newest artifact of that name a run kept: a re-run keeps
# another beside the first.
artifact_file() { # run id, artifact name, path inside it -> the local path, empty when there is none
  local id d="$WORK/artifact-$1-$2"
  id="$(gh api "repos/$REPO/actions/runs/$1/artifacts?per_page=100" -q "[.artifacts[] | select(.name == \"$2\")] | sort_by(.created_at) | last | .id // empty" 2>/dev/null || true)"
  [ -n "$id" ] || return 0
  mkdir -p "$d"
  gh api "repos/$REPO/actions/artifacts/$id/zip" > "$d.zip" 2>/dev/null || return 0
  (cd "$d" && unzip -o -q "$d.zip") 2>/dev/null || return 0
  [ ! -f "$d/$3" ] || echo "$d/$3"
}

# terragucci of the release, in a fresh clone of the sandbox with chant on the
# path, as an approver runs it. Prints what it printed.
approver() { # clone dir, terragucci arguments...
  local dir="$1"; shift
  git clone -q --no-single-branch "$GIT_URL" "$dir" || fail "could not clone $REPO"
  git -C "$dir" config user.name "$SIGNER"
  git -C "$dir" config user.email "$SIGNER@terragucci.local"
  git -C "$dir" config commit.gpgsign false
  (cd "$dir" && PATH="$HERE/../node_modules/.bin:$PATH" npx -y "@intentius/terragucci@$RELEASE" "$@" 2>&1) || true
}

# Lines on a ledger file of chant/lifecycle, as origin has it now.
ledger_lines() { # clone dir, path
  git -C "$1" fetch -q origin chant/lifecycle 2>/dev/null || true
  git -C "$1" show "origin/chant/lifecycle:$2" 2>/dev/null | wc -l | tr -d ' '
}

# ── the phases prove runs ────────────────────────────────────────────────────

verdict() { # claim, pass|fail, what was seen
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$WORK/verdicts"
  log "claim $1: $2 ($3)"
}
# Each step runs as its own command; a step that fails fails the claims that
# need it, and the rest still run.
step() { "$0" "$@" >"$DIR/logs/prove-$1-${2:-}.out"; }

# The merge phase: main as prove_main sets it, applying after merge.
prove_merge() {
  prove_main

  # affected: one-root changes dev orders alone.
  if step change one-root; then
    a="$(pr_for one-root open)"; head_a="$(head_of "$a")"
    roots="$(note_of "$a" | head -1 | sed -n 's/^<!-- terragucci:plan roots=\(.*\) -->$/\1/p')"
    plan="$(status_on "$head_a" terragucci/plan)"
    if [ "$roots" = envs/dev/orders ] && [[ "$plan" == "success 1 roots,"* ]]; then
      verdict affected pass "pull request $a: roots=$roots, terragucci/plan $plan"
    else
      verdict affected fail "pull request $a: roots=${roots:-none}, terragucci/plan ${plan:-none}"
    fi
  else
    a="" head_a=""
    verdict affected fail "change one-root failed"
  fi

  # note-footer: the one-root note's last line is the taco footer, and its
  # image is a PNG. tips: the note counts the tips its run's report holds.
  if [ -n "$a" ]; then
    note="$(note_of "$a")"
    footer="$(printf '%s\n' "$note" | sed '/^[[:space:]]*$/d' | tail -1)"
    img="$(grep -o 'src="[^"]*"' <<<"$footer" | head -1 | sed 's/^src="//; s/"$//' || true)"
    got="none" magic=""
    if [ -n "$img" ]; then
      got="$(curl -sS -o "$WORK/taco.png" -w '%{http_code} %{content_type}' "$img" 2>/dev/null || true)"
      magic="$(head -c 8 "$WORK/taco.png" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
    fi
    if [[ "$footer" == "<sub><img "*"Posted by [terragucci]("*"</sub>" ]] && [[ "$got" == "200 image/png"* ]] && [ "$magic" = 89504e470d0a1a0a ]; then
      verdict note-footer pass "pull request $a: the last line is the footer; $img answers $got with a PNG"
    else
      verdict note-footer fail "pull request $a: last line ${footer:-none}; ${img:-no image} answers ${got:-nothing}"
    fi
    run="$(gh run list -R "$REPO" --commit "$head_a" --event pull_request -L 1 --json databaseId -q '.[0].databaseId // empty' || true)"
    report="$(artifact_file "${run:-0}" terragucci-report report.json)"
    counted="$(sed -n 's/^\([0-9][0-9]*\) tips\{0,1\} on how the roots are set up.*/\1/p' <<<"$note" | head -1)"
    tips="$( [ -z "$report" ] || jq '[.tips // [] | .[] | select(.rule and (.url | startswith("https://")))] | length' "$report" 2>/dev/null || true)"
    rules="$( [ -z "$report" ] || jq -r '[.tips // [] | .[].rule] | unique | join(", ")' "$report" 2>/dev/null || true)"
    if [ -n "$counted" ] && [ "${tips:-0}" -gt 0 ] && [ "$counted" = "$tips" ]; then
      verdict tips pass "pull request $a: the note counts $counted tip(s); the report names $rules, each with its page"
    else
      verdict tips fail "pull request $a: the note counts ${counted:-no} tips; the report of run ${run:-none} holds ${tips:-no} with a rule and page"
    fi
  else
    verdict note-footer fail "no one-root pull request"
    verdict tips fail "no one-root pull request"
  fi

  # comment-plan: the comment's own run re-plans, and the note is edited after it.
  if [ -n "$a" ]; then
    since="$(now)"
    if step plan-comment one-root; then
      run="$(cat "$DIR/last-run")"
      replan="$(gh run view "$run" -R "$REPO" --json jobs -q '[.jobs[] | select(.name == "replan")][0].conclusion // "none"')"
      edited="$(gh api "repos/$REPO/issues/$a/comments?per_page=100" -q '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | first | .updated_at // empty')"
      if [ "$replan" = success ] && [[ "$edited" > "$since" || "$edited" == "$since" ]]; then
        verdict comment-plan pass "run $run: replan $replan, the note edited at $edited"
      else
        verdict comment-plan fail "run $run: replan $replan, the note edited at ${edited:-never} (comment at $since)"
      fi
    else
      verdict comment-plan fail "plan-comment one-root failed"
    fi
  else
    verdict comment-plan fail "no one-root pull request to comment on"
  fi

  # pr-lock: one-root holds dev orders; orders-note reaches it too. (The
  # check job of unformatted pushes its format with the job's token, which
  # starts no pr-lock run, so that pull request may never be answered.)
  if [ -n "$a" ]; then
    held="$(wait_status "$head_a" terragucci/lock success)"
    if step change orders-note; then
      b="$(pr_for orders-note open)"
      locked="$(wait_status "$(head_of "$b")" terragucci/lock failure)"
      reply="$(replies_of "$b" | grep -F "is locked by pull request $a" | head -1 || true)"
      # shellcheck disable=SC2016 # the reply quotes the root in backticks
      if [ "$held" = "success holds envs/dev/orders" ] && [ "${locked%% *}" = failure ] && grep -qF '`envs/dev/orders`' <<<"$reply"; then
        verdict pr-lock pass "pull request $a: terragucci/lock $held; pull request $b: terragucci/lock $locked; $reply"
      else
        verdict pr-lock fail "pull request $a: terragucci/lock ${held:-none}; pull request $b: terragucci/lock ${locked:-none}; reply: ${reply:-none}"
      fi
    else
      verdict pr-lock fail "change orders-note failed"
    fi
  else
    verdict pr-lock fail "no one-root pull request to hold the lock"
  fi

  # comment-agent: on the orders-note pull request, the stand-in agent's
  # edit is pushed as one commit on its head, which plans again; an ask that
  # also edits the pipeline is refused and the branch stays where it is.
  if [ -n "${b:-}" ]; then
    before="$(head_of "$b")"
    asked="$( (say "$b" "/terragucci agent say who is on call for dev orders") || true)"
    pushed="$(head_of "$b")"
    parent="$(gh api "repos/$REPO/commits/$pushed" -q '.parents[0].sha' 2>/dev/null || true)"
    replanned="none"
    [ "$pushed" = "$before" ] || replanned="$(wait_status "$pushed" terragucci/plan success)"
    touched="$( (say "$b" "/terragucci agent touch ci and say who is on call") || true)"
    after="$(head_of "$b")"
    if [ "$parent" = "$before" ] && grep -qF "/commit/$pushed" <<<"$asked" && [ "${replanned%% *}" = success ] \
      && [ "$after" = "$pushed" ] && grep -qF '.github/workflows/terragucci.yml' <<<"$touched"; then
      verdict comment-agent pass "pull request $b: ${asked#terragucci: }; terragucci/plan on ${pushed:0:8}: $replanned; the ask that touches CI: ${touched#terragucci: }"
    else
      verdict comment-agent fail "pull request $b: head ${before:0:8} then ${pushed:0:8} (parent ${parent:0:8}) then ${after:0:8}; reply: ${asked:-none}; terragucci/plan: $replanned; the ask that touches CI: ${touched:-no reply}"
    fi
  else
    verdict comment-agent fail "no orders-note pull request to ask on"
  fi

  # policy: replace plans a replaced table, which main's policy denies. The
  # step's plan run fails, which is the point.
  step change replace || true
  p="$(pr_for replace open)"
  if [ -n "$p" ]; then
    plan="$(status_on "$(head_of "$p")" terragucci/plan)"
    denied="$(note_of "$p" | grep -F "$DENIAL" | head -1 || true)"
    if [ "${plan%% *}" = failure ] && [ -n "$denied" ]; then
      verdict policy pass "pull request $p: terragucci/plan $plan; the note: $denied"
    else
      verdict policy fail "pull request $p: terragucci/plan ${plan:-none}; the note names no denial"
    fi
  else
    verdict policy fail "change replace opened no pull request"
  fi

  # oidc: the probe root's plan on a pull request, then its apply on main.
  if step change oidc; then
    o="$(pr_for oidc open)"
    run="$(gh run list -R "$REPO" --commit "$(head_of "$o")" --event pull_request -L 1 --json databaseId -q '.[0].databaseId // empty')"
    planned="$(probe_found "$run" plan)"
    applied=""
    if step merge oidc; then applied="$(probe_found "$(cat "$DIR/last-run")" apply)"; fi
    if jq -e '.verified and .problems == []' >/dev/null 2>&1 <<<"$planned" && jq -e '.verified and .problems == []' >/dev/null 2>&1 <<<"$applied"; then
      verdict oidc pass "$(jq -r '"plan job: \(.role), \(.sub), \(.aud)"' <<<"$planned"); $(jq -r '"apply job: \(.role), \(.sub)"' <<<"$applied")"
    else
      verdict oidc fail "pull request $o, plan job: ${planned:-nothing found}; apply job: ${applied:-nothing found}"
    fi
  else
    verdict oidc fail "change oidc failed"
  fi

  # comment-apply, first part: /terragucci apply on the merged oidc pull
  # request runs its apply again from the merge commit; on the open one-root
  # pull request it is refused. The third part waits with the destroy below.
  ca_merged="" ca_open="" ca_seen=""
  if [ -n "${o:-}" ] && [ "$(gh pr view "$o" -R "$REPO" --json state -q .state 2>/dev/null || true)" = MERGED ]; then
    merged_at="$(gh pr view "$o" -R "$REPO" --json mergeCommit -q .mergeCommit.oid)"
    r="$( (say "$o" "/terragucci apply") || true)"
    run="$(cat "$DIR/last-run")"
    job="$(job_conclusion "$run" apply-comment)"
    if [ "$job" = success ] && grep -qF "applied wave 1, 2, 3, 4 of pull request $o at ${merged_at:0:8}" <<<"$r" && grep -qF "/actions/runs/$run" <<<"$r"; then
      ca_merged="merged pull request $o: ${r#terragucci: }"
    fi
    ca_seen="merged pull request $o: apply-comment $job, reply ${r:-none}"
  fi
  if [ -n "$a" ]; then
    r="$( (say "$a" "/terragucci apply") || true)"
    grep -qF "pull request $a is not merged" <<<"$r" && ca_open="open pull request $a: ${r#terragucci: }"
    ca_seen="$ca_seen; open pull request $a: reply ${r:-none}"
  fi

  # policy-override: the merged override scenario's wave 1 is denied; an
  # override by a principal policy.override does not list counts for
  # nothing; one by the listed principal lets the re-run apply it, and the
  # report names the override.
  reason="the sandbox proves the override"
  if step change override; then
    po="$(pr_for override open)"
    step merge override || true
    run="$(cat "$DIR/last-run")"
    first="$(job_conclusion "$run" apply-wave-1)"
    d="$WORK/override-rules"
    git clone -q --no-single-branch "$GIT_URL" "$d" 2>/dev/null || true
    rules="$(git -C "$d" show origin/chant/lifecycle:_gates/policy-override.jsonl 2>/dev/null \
      | jq -rs --arg g "$PROBE" '[.[] | select(.kind == "pending" and .gate == $g)] | last | .rules // [] | join(",")' 2>/dev/null || true)"
    stranger="" listed="" second="none" third="none" named=""
    if [ "$first" = failure ] && [ -n "$rules" ]; then
      stranger="$(approver "$WORK/override-stranger" override "$PROBE" --rule "$rules" --reason "$reason" --actor "$STRANGER" --sign "$KEY")"
      printf '%s\n' "$stranger" > "$DIR/logs/override-stranger.log"
      second="$(rerun "$run")"
      grep -qF "$STRANGER is not listed under policy.override at base" "$(job_log "$run" apply-wave-1)" && refused=1 || refused=""
      listed="$(approver "$WORK/override-listed" override "$PROBE" --rule "$rules" --reason "$reason" --actor "$SIGNER" --sign "$KEY")"
      printf '%s\n' "$listed" > "$DIR/logs/override-listed.log"
      third="$(rerun "$run")"
      report="$(artifact_file "$run" terragucci-report-apply-wave-1 report.json)"
      [ -z "$report" ] || named="$(jq -r --arg r "$PROBE" --arg s "$SIGNER" --arg why "$reason" '
        (.roots[] | select(.path == $r) | .policy) as $p
        | if $p.result == "denied" and $p.override.by == $s and $p.override.reason == $why and ($p.override.rules | length > 0)
             and ($p.override.plan_digest | test("sha256:")) and (.policy.overridden == [$r])
          then "\($p.override.by), rules \($p.override.rules | join(", ")), plan \($p.override.plan_digest[0:24])…" else empty end' "$report" 2>/dev/null || true)"
      [ "$third" != success ] || ( record_state ) || log "could not record the state after the override"
    fi
    if [ "$first" = failure ] && [ "$second" = failure ] && [ -n "${refused:-}" ] && [ "$third" = success ] && [ -n "$named" ]; then
      verdict policy-override pass "pull request $po: run $run denied wave 1 ($rules); after $STRANGER's override it was denied again as not listed; after $SIGNER's it applied, and the report names the override by $named"
    else
      verdict policy-override fail "pull request ${po:-none}: run $run wave 1 $first; rules ${rules:-none}; after $STRANGER: $second (not listed named: ${refused:-no}); after $SIGNER: $third; report: ${named:-no override named}"
    fi
  else
    verdict policy-override fail "change override failed"
  fi

  # apply-serial: module-bump merges, and once its wave 1 is applying the
  # orders-note pull request merges too. No apply of one run overlaps one of
  # the other, none is cancelled, and each commit ends with one
  # terragucci/apply success.
  if [ -n "${b:-}" ] && step change module-bump; then
    m="$(pr_for module-bump open)"
    ( ensure_signer ) || true
    since="$(now)"
    gh pr merge "$m" -R "$REPO" --squash --admin >/dev/null 2>&1 || true
    sha1="$(gh pr view "$m" -R "$REPO" --json mergeCommit -q '.mergeCommit.oid // empty' || true)"
    run1="" run2="" sha2="" applying=""
    # The second merge waits until the first run's wave 1 is applying.
    for _ in $(seq 1 100); do
      [ -n "$run1" ] || run1="$(gh run list -R "$REPO" --commit "$sha1" --event push -L 1 --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)"
      [ -z "$run1" ] || applying="$(gh api "repos/$REPO/actions/runs/$run1/jobs?per_page=100" \
        -q '[.jobs[] | select(.name == "apply-wave-1") | .steps[]? | select(.name | startswith("Apply wave")) | .status] | first // ""' 2>/dev/null || true)"
      case "$applying" in in_progress|completed) break ;; esac
      sleep 3
    done
    log "run ${run1:-none} on ${sha1:0:8} is applying wave 1; merging pull request $b"
    gh pr merge "$b" -R "$REPO" --squash --admin >/dev/null 2>&1 || true
    sha2="$(gh pr view "$b" -R "$REPO" --json mergeCommit -q '.mergeCommit.oid // empty' || true)"
    ( wait_run push "$since" "$sha2" ) >/dev/null 2>&1 || true
    run2="$(gh run list -R "$REPO" --commit "$sha2" --event push -L 1 --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)"
    [ -z "$run1" ] || gh run watch "$run1" -R "$REPO" --interval 10 >/dev/null 2>&1 || true
    spans="$(for r in $run1 $run2; do
      gh api "repos/$REPO/actions/runs/$r/jobs?per_page=100" | jq -c --arg r "$r" '.jobs[] | select(.name | startswith("apply-wave-"))
        | {run: $r, job: .name, conclusion, steps: [.steps[] | select(.name | startswith("Apply wave")) | select(.started_at != null and .completed_at != null)]}
        | select(.steps | length > 0) | {run, job, conclusion, start: .steps[0].started_at, end: .steps[0].completed_at}'
    done | jq -s . 2>/dev/null || echo '[]')"
    overlaps="$(jq '[.[] as $x | .[] as $y | select($x.run < $y.run and $x.start < $y.end and $y.start < $x.end)] | length' <<<"$spans")"
    cancelled="$(for r in $run1 $run2; do gh run view "$r" -R "$REPO" --json jobs -q '.jobs[] | select(.conclusion == "cancelled") | .name'; done | tr '\n' ' ')"
    first_order="$(jq -r --arg a "$run1" --arg b "$run2" '([.[] | select(.run == $a and .job == "apply-wave-1")][0].start) < ([.[] | select(.run == $b and .job == "apply-wave-1")][0].start // "~")' <<<"$spans")"
    c1="$(gh run view "$run1" -R "$REPO" --json conclusion -q .conclusion 2>/dev/null || echo none)"
    c2="$(gh run view "$run2" -R "$REPO" --json conclusion -q .conclusion 2>/dev/null || echo none)"
    s1="$(status_on "$sha1" terragucci/apply)"; s2="$(status_on "$sha2" terragucci/apply)"
    ran="$(jq -r 'map("\(.run)/\(.job) \(.start[11:19])-\(.end[11:19])") | join(", ")' <<<"$spans")"
    if [ "$overlaps" = 0 ] && [ -z "${cancelled// /}" ] && [ "$first_order" = true ] && [ "$c1" = success ] && [ "$c2" = success ] \
      && [ "${s1%% *}" = success ] && [ "${s2%% *}" = success ]; then
      verdict apply-serial pass "pull requests $m and $b merged back to back: $ran; no overlap, none cancelled; ${sha1:0:8} terragucci/apply $s1; ${sha2:0:8} terragucci/apply $s2"
    else
      verdict apply-serial fail "runs $run1 ($c1) and $run2 ($c2): $ran; overlaps $overlaps; cancelled: ${cancelled:-none}; first in order: $first_order; ${sha1:0:8} ${s1:-no status}; ${sha2:0:8} ${s2:-no status}"
    fi
    ( record_state ) || log "could not record the state after the two merges"
  else
    verdict apply-serial fail "no orders-note pull request, or change module-bump failed"
  fi

  # gate-wait: the destroy's wave waits, and applies once approved.
  if step change destroy && step merge destroy && [ -f "$DIR/waiting" ]; then
    IFS=$'\t' read -r run wave _ < "$DIR/waiting"
    waited="$(grep -m1 'chant approve tf-apply' "$DIR/logs/waiting.log" | sed 's/^[[:space:]]*//' || true)"
    # comment-apply, third part: while wave 4 waits, the comment on the
    # merged destroy applies nothing and gives the approve command.
    dp="$(gh pr list -R "$REPO" --head change/destroy --state merged --json number -q '.[0].number // empty' || true)"
    if [ -n "$dp" ]; then
      r="$( (say "$dp" "/terragucci apply") || true)"
      if grep -Eq "wave 4 waits for an approval of its set digest (jcs1-)?sha256:[0-9a-f]+" <<<"$r" \
        && grep -Eq 'chant approve tf-apply wave-4 --plan (jcs1-)?sha256:[0-9a-f]+ --sign' <<<"$r"; then
        ca_wait="merged pull request $dp while wave 4 waits: ${r#terragucci: }"
      fi
      ca_seen="$ca_seen; merged pull request $dp while wave 4 waits: reply ${r:-none}"
    fi
    if step approve; then
      verdict gate-wait pass "run $run stopped $wave with: $waited; approved and re-run, it applied"
    else
      verdict gate-wait fail "run $run stopped $wave; the re-run after the approval did not succeed"
    fi
  else
    verdict gate-wait fail "the merged destroy left no wave waiting"
  fi
  if [ -n "$ca_merged" ] && [ -n "$ca_open" ] && [ -n "${ca_wait:-}" ]; then
    verdict comment-apply pass "$ca_merged; $ca_open; $ca_wait"
  else
    verdict comment-apply fail "${ca_seen#; }"
  fi

  # explain-refusal: refuse destroys in wave 4 after its last approval, so
  # the wave is refused, and the guide's job runs on the refusal and prints
  # what moved.
  refused_run=""
  if step change refuse; then
    step merge refuse || true
    run="$(cat "$DIR/last-run")"
    wave4="$(job_conclusion "$run" apply-wave-4)"
    grep -qE 'changed after it was approved|planned differently since' "$(job_log "$run" apply-wave-4)" && refused_run="$run"
    explained="$(job_conclusion "$run" explain-refusal)"
    moved="$(grep -m1 '^roots that moved: ' "$(job_log "$run" explain-refusal)" | sed 's/^roots that moved: //' || true)"
    if [ -n "$refused_run" ] && [ "$explained" = success ] && grep -qF envs/staging/payments <<<"$moved"; then
      verdict explain-refusal pass "run $run: apply-wave-4 refused; explain-refusal ran the page's steps and printed the roots that moved: $moved"
    else
      verdict explain-refusal fail "run $run: apply-wave-4 $wave4 (refused: ${refused_run:+yes}); explain-refusal $explained; roots that moved: ${moved:-none}"
    fi
  else
    verdict explain-refusal fail "change refuse failed"
  fi

  # approve-command: with the refused wave waiting for its new plan,
  # terragucci approve --dry-run in a clone records nothing; terragucci
  # approve, given no digest, approves the wave, and the re-run applies it.
  if [ -n "$refused_run" ]; then
    dry="$(approver "$WORK/approve-dry" approve --actor "$SIGNER" --sign "$KEY" --dry-run)"
    printf '%s\n' "$dry" > "$DIR/logs/approve-dry-run.log"
    before="$(ledger_lines "$WORK/approve-dry" _gates/tf-apply.jsonl)"
    sleep 5
    kept="$(ledger_lines "$WORK/approve-dry" _gates/tf-apply.jsonl)"
    out="$(approver "$WORK/approve-real" approve --actor "$SIGNER" --sign "$KEY")"
    printf '%s\n' "$out" > "$DIR/logs/approve-real.log"
    ran="$(grep -m1 '^running: chant approve tf-apply wave-4 --plan ' <<<"$out" | sed 's/ --sign .*//' || true)"
    again="$(rerun "$refused_run")"
    if grep -q 'chant approve tf-apply wave-4 --plan ' <<<"$dry" && [ "$before" = "$kept" ] && [ -n "$ran" ] && [ "$again" = success ]; then
      verdict approve-command pass "run $refused_run: --dry-run printed the command and the ledger kept $kept lines; terragucci approve ${ran#running: }; the re-run applied wave 4"
      ( record_state ) || log "could not record the state after the approval"
    else
      verdict approve-command fail "run $refused_run: dry run: $(tr '\n' ' ' <<<"$dry" | cut -c1-200); ledger $before then $kept lines; approve: $(tr '\n' ' ' <<<"$out" | cut -c1-200); re-run $again"
    fi
  else
    verdict approve-command fail "no refused wave to approve"
  fi

  # drift-issue: the drift job opens the drift issue, a second run updates
  # that issue, and once the file is back a third closes it.
  if step drift; then
    issue="$(gh issue list -R "$REPO" --state open -L 1 --json number -q '.[0].number // empty' || true)"
    first="$(gh issue view "$issue" -R "$REPO" --json updatedAt -q .updatedAt 2>/dev/null || true)"
    since="$(now)"
    gh workflow run terragucci.yml -R "$REPO" --ref main >/dev/null 2>&1 || true
    ( wait_run workflow_dispatch "$since" ) >/dev/null 2>&1 || true
    run2="$(cat "$DIR/last-run")"
    open2="$(gh issue list -R "$REPO" --state open --json number -q 'map(.number) | join(",")' || true)"
    second="$(gh issue view "$issue" -R "$REPO" --json updatedAt,body -q 'if (.body | contains("/actions/runs/'"$run2"'")) then .updatedAt else "" end' 2>/dev/null || true)"
    ( tree="$WORK/drift-back"
      clone_main "$tree"
      printf 'shop-staging-orders-jobs\n' > "$tree/envs/staging/orders/jobs-queue.txt"
      commit "$tree" "Put staging orders' jobs queue back [skip ci]"
      push "$tree" main >/dev/null ) || log "could not put the jobs queue file back"
    since="$(now)"
    gh workflow run terragucci.yml -R "$REPO" --ref main >/dev/null 2>&1 || true
    ( wait_run workflow_dispatch "$since" ) >/dev/null 2>&1 || true
    run3="$(cat "$DIR/last-run")"
    state3="$(gh issue view "$issue" -R "$REPO" --json state -q .state 2>/dev/null || true)"
    closing="$(gh api "repos/$REPO/issues/$issue/comments?per_page=100" -q '[.[] | .body] | last // "" | split("\n")[0]' 2>/dev/null || true)"
    if [ -n "$issue" ] && [ "$open2" = "$issue" ] && [ -n "$second" ] && [[ "$second" > "$first" ]] && [ "$state3" = CLOSED ] && [[ "$closing" == "No drift at "* ]]; then
      verdict drift-issue pass "issue $issue: opened by the first run, the only open issue after run $run2, which updated it; closed by run $run3: $closing"
    else
      verdict drift-issue fail "issue ${issue:-none}: open after run $run2: ${open2:-none}; updated by it: ${second:-no}; after run $run3: ${state3:-unknown}, ${closing:-no comment}"
    fi
  else
    verdict drift-issue fail "the drift run opened no issue"
  fi
}

# The pull-request phase: apply.when: pull-request, first with merge: manual,
# then merge: auto with the job's token, then with a merge token. Its pull
# requests are opened by the sandbox-open workflow as github-actions[bot], so
# the person running prove is not their author and may approve them.
MERGE_SECRET=SANDBOX_MERGE_TOKEN
pr_config() { # merge (manual|auto), [merge token secret]
  local tree="$WORK/pr-config-$1${2:+-token}" sha
  clone_main "$tree"
  awk '/^# Set by stack\/sandbox-github.sh prove pull-request/ { exit } { print }' "$tree/terragucci.yml" > "$tree/terragucci.yml.new"
  mv "$tree/terragucci.yml.new" "$tree/terragucci.yml"
  {
    echo "# Set by stack/sandbox-github.sh prove pull-request; reset takes it away."
    echo "apply:"
    echo "  when: pull-request"
    echo "  merge: $1"
    [ -z "${2:-}" ] || echo "  merge_token_env: $2"
  } >> "$tree/terragucci.yml"
  mkdir -p "$tree/.github/workflows"
  cat > "$tree/.github/workflows/sandbox-open.yml" <<'YML'
# stack/sandbox-github.sh prove pull-request opens its pull requests through
# this workflow, so their author is github-actions[bot] and the person running
# prove may approve them. reset takes it away.
name: sandbox-open
on:
  workflow_dispatch:
    inputs:
      head: { required: true }
      title: { required: true }
permissions:
  contents: read
  pull-requests: write
jobs:
  open:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr create -R "$GITHUB_REPOSITORY" --head "$HEAD" --base main --title "$TITLE" --body "Opened by the sandbox-open workflow, so the person running prove may approve it."
        env:
          GH_TOKEN: ${{ github.token }}
          HEAD: ${{ inputs.head }}
          TITLE: ${{ inputs.title }}
YML
  (cd "$tree" && npx -y "@intentius/terragucci@$RELEASE" init >"$DIR/logs/prove-pr-init.log" 2>&1) \
    || { cat "$DIR/logs/prove-pr-init.log" >&2; fail "terragucci init failed"; }
  grep -q '^  apply-comment:' "$tree/.github/workflows/terragucci.yml" || fail "init wrote no apply-comment job"
  commit "$tree" "Apply pull requests before merge, merge: $1${2:+ with $2} [skip ci]"
  sha="$(push "$tree" main)"
  log "main at ${sha:0:8}: apply.when: pull-request, merge: $1${2:+, merge_token_env: $2}"
}

# A pull request that sets one root's job retention, opened by sandbox-open,
# planned and approved. Prints its number.
bot_pr() { # branch, root, seconds, title
  local tree="$WORK/bot-$1" f since sha n i
  clone_main "$tree"
  git -C "$tree" checkout -q -b "change/$1"
  f="$tree/$2/main.tf"
  awk -v s="$3" '{ print } /^  logs_bucket = / { print ""; print "  job_retention_seconds = " s }' "$f" > "$f.new" && mv "$f.new" "$f"
  commit "$tree" "$4"
  push "$tree" "change/$1" >/dev/null
  since="$(now)"
  gh workflow run sandbox-open.yml -R "$REPO" --ref main -f head="change/$1" -f title="$4" >/dev/null || fail "could not start sandbox-open"
  wait_run workflow_dispatch "$since" >&2
  n=""
  for i in $(seq 1 20); do
    n="$(pr_for "$1" open)"; [ -n "$n" ] && break; sleep 3
  done
  [ -n "$n" ] || fail "sandbox-open opened no pull request for change/$1"
  # A pull request a workflow's token opens starts no run; this push does.
  git -C "$tree" -c user.name=terragucci -c user.email=sandbox@terragucci.local -c commit.gpgsign=false commit -q --allow-empty -m "Plan it"
  since="$(now)"
  sha="$(push "$tree" "change/$1")"
  wait_run pull_request "$since" "$sha" >&2
  wait_run push "$since" "$sha" >&2
  gh pr review "$n" -R "$REPO" --approve --body "Reviewed by the person running prove." >/dev/null || fail "could not approve pull request $n"
  log "pull request $n (change/$1, by github-actions[bot]) planned at ${sha:0:8} and approved"
  echo "$n"
}

prove_pull_request() {
  local x y c d e r1 r2 r3 r4 held at moved n merged by pushed
  ( pr_config manual ) || { for x in pr-apply-lock pr-apply-stale pr-apply pr-apply-token; do verdict "$x" fail "main could not be set up"; done; return 0; }

  # pr-apply-lock: x and y both change dev orders. x applies from its head
  # and holds the lock; y is refused, naming the root and x; once x is
  # unlocked, y applies.
  x="$( (bot_pr lock-a envs/dev/orders 600 "Keep dev orders' jobs ten minutes") || true)"
  y="$( (bot_pr lock-b envs/dev/orders 900 "Keep dev orders' jobs fifteen minutes") || true)"
  if [ -n "$x" ] && [ -n "$y" ]; then
    r1="$( (say "$x" "/terragucci apply") || true)"
    r2="$( (say "$y" "/terragucci apply") || true)"
    r3="$( (say "$x" "/terragucci unlock") || true)"
    r4="$( (say "$y" "/terragucci apply") || true)"
    if grep -qF "applied wave 1, 2, 3, 4 of pull request $x" <<<"$r1" && grep -qF "Merge it when you are ready" <<<"$r1" \
      && grep -qF "\`envs/dev/orders\` is locked by pull request $x" <<<"$r2" \
      && grep -qE "released the locks pull request $x held on .*envs/dev/orders" <<<"$r3" \
      && grep -qF "applied wave 1, 2, 3, 4 of pull request $y" <<<"$r4"; then
      verdict pr-apply-lock pass "pull request $x: ${r1#terragucci: }; pull request $y: ${r2#terragucci: }; unlock on $x: ${r3#terragucci: }; then $y: ${r4#terragucci: }"
    else
      verdict pr-apply-lock fail "pull request $x: ${r1:-no reply}; $y: ${r2:-no reply}; unlock on $x: ${r3:-no reply}; then $y: ${r4:-no reply}"
    fi
  else
    verdict pr-apply-lock fail "sandbox-open could not open and plan both pull requests"
  fi

  # pr-apply-stale: c is approved, then main moves; /terragucci apply on c is
  # refused as not up to date, and nothing applies.
  c="$( (bot_pr stale envs/dev/payments 600 "Keep dev payments' jobs ten minutes") || true)"
  if [ -n "$c" ]; then
    ( tree="$WORK/stale-main"; clone_main "$tree"; printf '\nmain moved under an open pull request.\n' >> "$tree/README.md"
      commit "$tree" "Move main under an open pull request [skip ci]"; push "$tree" main >/dev/null ) || true
    r1="$( (say "$c" "/terragucci apply") || true)"
    run="$(cat "$DIR/last-run")"
    applied="$(grep -c 'Apply complete' "$(job_log "$run" apply-comment)" || true)"
    if grep -qF "pull request $c is not up to date with main" <<<"$r1" && [ "${applied:-0}" = 0 ]; then
      verdict pr-apply-stale pass "pull request $c, after main moved: ${r1#terragucci: }; run $run applied nothing"
    else
      verdict pr-apply-stale fail "pull request $c: ${r1:-no reply}; run $run has ${applied:-0} applies"
    fi
  else
    verdict pr-apply-stale fail "sandbox-open could not open and plan the pull request"
  fi

  # pr-apply: merge: auto with the job's token. d applies from its head and
  # pr-merge merges it as github-actions[bot].
  ( pr_config auto ) || true
  d="$( (bot_pr auto envs/dev/search 600 "Keep dev search's jobs ten minutes") || true)"
  if [ -n "$d" ]; then
    at="$(head_of "$d")"
    r1="$( (say "$d" "/terragucci apply") || true)"
    merged="$(gh pr view "$d" -R "$REPO" --json state,mergedBy -q '"\(.state) \(.mergedBy.login // "nobody")"' || true)"
    if grep -qF "applied wave 1, 2, 3, 4 of pull request $d at ${at:0:8}, and merged pull request $d" <<<"$r1" && [ "${merged%% *}" = MERGED ]; then
      verdict pr-apply pass "pull request $d: ${r1#terragucci: }; $merged"
    else
      verdict pr-apply fail "pull request $d: ${r1:-no reply}; ${merged:-unknown}"
    fi
  else
    verdict pr-apply fail "sandbox-open could not open and plan the pull request"
  fi

  # pr-apply-token: merge: auto with merge_token_env. e applies and is merged
  # with the merge token, whose push starts the run on main.
  gh secret set "$MERGE_SECRET" -R "$REPO" --body "$GH_TOKEN" >/dev/null || true
  ( pr_config auto "$MERGE_SECRET" ) || true
  e="$( (bot_pr token envs/dev/email 600 "Keep dev email's jobs ten minutes") || true)"
  if [ -n "$e" ]; then
    at="$(head_of "$e")"
    r1="$( (say "$e" "/terragucci apply") || true)"
    merged="$(gh pr view "$e" -R "$REPO" --json state,mergedBy,mergeCommit -q '"\(.state) \(.mergedBy.login // "nobody") \(.mergeCommit.oid // "")"' || true)"
    by="$(cut -d' ' -f2 <<<"$merged")"; n="$(cut -d' ' -f3 <<<"$merged")"
    pushed=""
    for _ in $(seq 1 20); do
      pushed="$(gh run list -R "$REPO" --commit "$n" --event push -L 1 --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)"
      [ -n "$pushed" ] && break; sleep 3
    done
    if grep -qF "applied wave 1, 2, 3, 4 of pull request $e at ${at:0:8}, and merged pull request $e" <<<"$r1" && [ "${merged%% *}" = MERGED ] \
      && [ "$by" != "github-actions" ] && [ -n "$pushed" ]; then
      verdict pr-apply-token pass "pull request $e: ${r1#terragucci: }; merged by $by with the merge token, and its push started run $pushed on main"
    else
      verdict pr-apply-token fail "pull request $e: ${r1:-no reply}; ${merged:-unknown}; run on the merge commit: ${pushed:-none}"
    fi
  else
    verdict pr-apply-token fail "sandbox-open could not open and plan the pull request"
  fi
}

# The modules phase: modules.publish: git-tags. A conventional commit to
# modules/service on main publishes it as a git tag from the pipeline's
# publish job; then every root pins that tag, a second commit publishes the
# next version, and terragucci rollout opens the canary wave's pull request.
module_tags() { # -> the module tags on the sandbox, comma-separated, oldest version first
  git ls-remote --tags "$GIT_URL" 'refs/tags/modules/*' 2>/dev/null | sed -E 's#.*refs/tags/##; /\^\{\}$/d' | sort -V | paste -sd, -
}

module_commit() { # message, output name -> pushes a commit to main that adds an output to modules/service and waits for its run; prints the run id
  local tree="$WORK/module-$2" since sha
  clone_main "$tree"
  printf '\noutput "%s" {\n  value = var.name\n}\n' "$2" >> "$tree/modules/service/main.tf"
  commit "$tree" "$1"
  since="$(now)"
  sha="$(push "$tree" main)"
  wait_run push "$since" "$sha" >&2
  echo "$RUN_ID"
}

prove_modules() {
  local tree run1 run2 t1 t2 out pr files moved others
  ( tree="$WORK/modules-main"
    clone_main "$tree"
    printf '# Set by stack/sandbox-github.sh prove modules; reset takes it away.\nmodules:\n  path: "modules/*"\n  publish: git-tags\n' >> "$tree/terragucci.yml"
    (cd "$tree" && npx -y "@intentius/terragucci@$RELEASE" init >"$DIR/logs/prove-modules-init.log" 2>&1) || fail "terragucci init failed"
    grep -q '^  publish:' "$tree/.github/workflows/terragucci.yml" || fail "init wrote no publish job"
    commit "$tree" "Publish the modules as git tags [skip ci]"
    push "$tree" main >/dev/null ) || { verdict publish fail "main could not be set up"; verdict rollout fail "main could not be set up"; return 0; }

  # publish: the first commit to modules/service publishes it.
  run1="$( (module_commit "feat(service): name the service in an output" service_name) || true)"
  t1="$(module_tags)"
  if [ "$(job_conclusion "${run1:-0}" publish)" = success ] && [[ "$t1" == modules/service/v* ]] && [[ "$t1" != *,* ]]; then
    verdict publish pass "run $run1: the publish job pushed $t1"
  else
    verdict publish fail "run ${run1:-none}: publish $(job_conclusion "${run1:-0}" publish); tags: ${t1:-none}"
  fi

  # rollout: the roots pin that tag, the next commit publishes another, and
  # the rollout opens one pull request for the canary wave.
  if [[ "$t1" == modules/service/v* ]] && [[ "$t1" != *,* ]]; then
    ( tree="$WORK/modules-pin"
      clone_main "$tree"
      for f in "$tree"/envs/*/*/main.tf; do
        sed "s#source = \"../../../modules/service\"#source = \"git::$GIT_URL//modules/service?ref=$t1\"#" "$f" > "$f.new" && mv "$f.new" "$f"
      done
      commit "$tree" "Pin every root to $t1 [skip ci]"
      push "$tree" main >/dev/null ) || true
    run2="$( (module_commit "feat(service): name the environment in an output" service_env) || true)"
    t2="$(module_tags | tr ',' '\n' | grep -vxF "$t1" | tail -1)"
    out=""
    if [ -n "$t2" ]; then
      tree="$WORK/modules-rollout"
      git clone -q "$GIT_URL" "$tree" 2>/dev/null || true
      out="$(cd "$tree" && GITHUB_TOKEN="$GH_TOKEN" npx -y -p "@intentius/terragucci@$RELEASE" -p @cdktn/hcl2json \
        terragucci rollout modules/service "${t2##*/v}" --mode apply 2>&1 || true)"
      printf '%s\n' "$out" > "$DIR/logs/rollout.log"
    fi
    pr="$(gh pr list -R "$REPO" --state open -L 1 --json number -q '.[0].number // empty' || true)"
    files="$( [ -z "$pr" ] || gh pr view "$pr" -R "$REPO" --json files -q '[.files[].path] | join(" ")' 2>/dev/null || true)"
    moved="$( [ -z "$pr" ] || gh pr diff "$pr" -R "$REPO" 2>/dev/null | grep -c "^+.*ref=$t2\"" || true)"
    others="$(tr ' ' '\n' <<<"$files" | grep -vc '^envs/dev/' || true)"
    if [ -n "$pr" ] && [ -n "$files" ] && [ "${others:-1}" = 0 ] && [ "${moved:-0}" -gt 0 ]; then
      verdict rollout pass "after run $run2 published $t2, terragucci rollout opened pull request $pr for the canary wave: $files move to $t2"
    else
      verdict rollout fail "run ${run2:-none} published ${t2:-nothing}; rollout: $(tail -3 <<<"$out" | tr '\n' ' '); pull request ${pr:-none}: ${files:-no files}"
    fi
  else
    verdict rollout fail "no first module version to pin"
  fi
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
  for b in $(gh api "repos/$REPO/tags?per_page=100" -q '.[].name' 2>/dev/null || true); do
    gh api -X DELETE "repos/$REPO/git/refs/tags/$b" >/dev/null && log "deleted tag $b"
  done
  for b in $(gh secret list -R "$REPO" --json name -q '.[].name' 2>/dev/null || true); do
    gh secret delete "$b" -R "$REPO" >/dev/null && log "deleted secret $b"
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
    clone_main "$WORK/tree"
    git -C "$WORK/tree" checkout -q -b "change/$name"
    if [ "$name" = oidc ]; then
      # The probe root's one input moves, so the root plans and applies again.
      [ -f "$WORK/tree/$PROBE/rev.txt" ] || fail "main has no $PROBE; run 'just sandbox prove', which adds it"
      date -u +%Y-%m-%dT%H:%M:%SZ > "$WORK/tree/$PROBE/rev.txt"
    elif [ "$name" = orders-note ]; then
      # A second change to dev orders, formatted, so no job pushes on top of it.
      printf '\n# The orders team owns this root.\n' >> "$WORK/tree/envs/dev/orders/main.tf"
    elif [ "$name" = override ]; then
      # The probe root's input takes the value main's policy denies.
      [ -f "$WORK/tree/$PROBE/rev.txt" ] || fail "main has no $PROBE; run 'just sandbox prove', which adds it"
      echo "$HELD" > "$WORK/tree/$PROBE/rev.txt"
    elif [ "$name" = refuse ]; then
      # A second destroy in wave 4, as the destroy scenario is in staging email.
      f="$WORK/tree/envs/staging/payments/main.tf"
      awk '{ print } /^  logs_bucket = / { print ""; print "  # Payments in staging no longer keeps records."; print "  records_table = false" }' "$f" > "$f.new" && mv "$f.new" "$f"
      grep -q 'records_table = false' "$f" || fail "no module block to change in envs/staging/payments"
    else
      patch="$(scenario_patch "$name")"
      git -C "$WORK/tree" apply -p1 "$patch" || fail "$name does not apply to main; run 'just sandbox reset' first"
    fi
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

  prove)
    record="" phases=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --record) record="${2:?--record needs a file}"; shift 2 ;;
        merge|pull-request|modules) phases="$phases $1"; shift ;;
        *) fail "unknown argument '$1' (merge, pull-request, modules, --record FILE)" ;;
      esac
    done
    [ -n "$phases" ] || phases="merge"
    if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then fail "prove needs Docker, for the roots' state"; fi
    started="$(date +%s)"
    : > "$WORK/verdicts"
    for phase in $phases; do
      "$0" reset
      log "phase $phase"
      "prove_${phase//-/_}"
    done

    "$0" reset
    printf '\n'
    rc=0
    while IFS=$'\t' read -r claim result seen; do
      printf '  %-16s %-5s %s\n' "$claim" "$result" "$seen"
      [ "$result" = pass ] || rc=1
    done < "$WORK/verdicts"
    printf '  Took             %s minutes\n' "$(( ($(date +%s) - started + 59) / 60 ))"
    # The rows the validation page lists, beside the local stack's: each
    # github.com row this run made replaces the one of its claim, new ones
    # follow, and the github.com rows go after the GitHub rows.
    rows="$(while IFS=$'\t' read -r claim result _; do
      says="$(grep "^github.com|$claim|" <<<"$PROVE_CLAIMS" | cut -d'|' -f3)"
      jq -n --arg c "$claim" --arg s "$says" --arg v "$result" '{forge: "github.com", claim: $c, says: $s, verdict: $v, break: null}'
    done < "$WORK/verdicts" | jq -s .)"
    jq '{release: $release, claims: .}' --arg release "$RELEASE" <<<"$rows" > "$DIR/prove.json"
    if [ -n "$record" ]; then
      jq --argjson rows "$rows" '.claims |= (
        [.[] | select(.forge == "github.com")] as $old | ($old | map(.claim)) as $had
        | ([$old[] | . as $r | ([$rows[] | select(.claim == $r.claim)] | first) // $r] + [$rows[] | select(.claim | IN($had[]) | not)]) as $gh
        | [.[] | select(.forge != "github.com")]
        | (map(.forge == "github") | rindex(true) // (length - 1)) as $i | .[:$i + 1] + $gh + .[$i + 1:])' "$record" > "$WORK/record"
      cp "$WORK/record" "$record"
      log "wrote the github.com rows into $record"
    fi
    exit $rc
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
