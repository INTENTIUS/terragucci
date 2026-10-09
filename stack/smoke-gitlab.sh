# shellcheck shell=bash disable=SC2034
# The smoke claims on GitLab, sourced by stack/smoke.sh. They run on the
# GitLab lab (stack/gitlab/gitlab.sh, compose project tglab) when SMOKE_FORGE
# is gitlab:
#
#   just gitlab-lab up
#   just gitlab-claims tips note-footer      plain and under BREAK=1, rows into smoke.json
#   SMOKE_FORGE=gitlab stack/smoke.sh tips   one run, for debugging
#
# Each claim pushes a small repo with the pipeline `terragucci init --forge
# gitlab` writes to a project of its own on the lab, and reads what GitLab
# shows: the merge request's notes, the pipelines, their jobs, logs and
# artifacts, and the commit statuses. A claim's project is named after the
# claim and the run (plain or break), so both runs go at once; a run first
# deletes the projects an earlier run of it left. Its state and marks in the
# lab's floci are under the same name.
#
# A row of smoke.json from these claims carries forge: gitlab. A claim of the
# same name on Forgejo is the claim_<name> in smoke.sh; GitLab's is
# gitlab_claim_<name> here.

# name|what the site says|issue that builds it (empty: implemented here)
GITLAB_CLAIMS='note-footer|the plan note on a merge request ends with the terragucci footer, GitLab renders its taco image, and the image answers 200 with a PNG|
tips|the plan note on a merge request counts the tips the plan report holds, each naming its rule and page|
apply-serial|two pushes to main apply one after the other through the resource group, none is cancelled, and the commit carries one terragucci/apply success|
policy-override|a wave the policy denies is retried with no effect after an override by someone policy.override does not list, applies after the listed approver overrides its plan, and its report names the override|'

# As CLAIM_GROUPS in smoke.sh. Each run has its own project, so plain and
# break overlap. runner is the lab's one gitlab-runner (concurrent = 4):
# apply-serial's BREAK run holds it alone, so a lack of free slots never
# orders its two applies.
GITLAB_CLAIM_GROUPS='
note-footer      runner weight=100
tips             runner weight=100
apply-serial     runner break:runner! weight=300
policy-override  runner weight=250
'

GITLAB_LAB_ENV="$HERE/gitlab/.state/gitlab.env"
# How long a claim waits for a pipeline or a job, as lib.sh's TIMEOUT.
GL_TIMEOUT="${TERRAGUCCI_VALIDATE_TIMEOUT:-900}"

# The lab's address and token, for the runner and every claim.
gitlab_lab_env() {
  [ -f "$GITLAB_LAB_ENV" ] || { echo "[smoke] no GitLab lab: run 'just gitlab-lab up' first" >&2; return 1; }
  # shellcheck disable=SC1090
  . "$GITLAB_LAB_ENV"
  curl -fsS -o /dev/null -H "PRIVATE-TOKEN: $TERRAGUCCI_GITLAB_TOKEN" "$TERRAGUCCI_GITLAB_URL/api/v4/user" 2>/dev/null \
    || { echo "[smoke] the GitLab lab at $TERRAGUCCI_GITLAB_URL does not answer; run 'just gitlab-lab up'" >&2; return 1; }
  export TERRAGUCCI_GITLAB_URL TERRAGUCCI_GITLAB_TOKEN TERRAGUCCI_GITLAB_USER TERRAGUCCI_FLOCI_URL TGLAB_NETWORK TGLAB_JOB_CACHE
}

# ── helpers ───────────────────────────────────────────────────────────────

gl_load() {
  gitlab_lab_env || return 1
  GL_URL="$TERRAGUCCI_GITLAB_URL"; GL_TOKEN="$TERRAGUCCI_GITLAB_TOKEN"; GL_USER="$TERRAGUCCI_GITLAB_USER"; GL_FLOCI="$TERRAGUCCI_FLOCI_URL"
}
glapi() { curl -fsS -H "PRIVATE-TOKEN: $GL_TOKEN" "$@"; }
gl_uri() { printf %s "$1" | jq -sRr @uri; }
# The project's API root.
gl_p() { echo "$GL_URL/api/v4/projects/$(gl_uri "$GL_USER/$1")"; }
# GitLab builds links from its in-network address; show the one a browser opens.
gl_browser() { sed "s#^http://gitlab:8929#$GL_URL#"; }

# A new public project for this run, with the token the pipeline's jobs call
# GitLab with. Projects an earlier run of the claim left are deleted first;
# the newest is kept until then, to look at.
gl_project() { # claim -> prints the project name
  local base="smoke-$1-${BREAK:+break}" name id
  base="${base%-}"
  [ -n "${BREAK:-}" ] || base="$base-plain"
  for id in $(glapi "$GL_URL/api/v4/projects?search=$base-&owned=true&per_page=100" | jq -r --arg b "$base-" '.[] | select(.path | startswith($b)) | .id'); do
    glapi -o /dev/null -X DELETE "$GL_URL/api/v4/projects/$id" 2>/dev/null || true
  done
  name="$base-$(date +%s)"
  glapi -o /dev/null -X POST "$GL_URL/api/v4/projects" --data-urlencode "name=$name" --data-urlencode "path=$name" \
    --data-urlencode "visibility=public" --data-urlencode "initialize_with_readme=false" --data-urlencode "default_branch=main" || return 1
  glapi -o /dev/null -X POST "$(gl_p "$name")/variables" --data-urlencode "key=GITLAB_TOKEN" \
    --data-urlencode "value=$GL_TOKEN" --data-urlencode "protected=false" --data-urlencode "masked=false" || return 1
  echo "$name"
}

# DIR as one commit on BRANCH, pushed. init pins the images by the digest of
# the published release; the pipeline names them by tag alone, so the runner
# takes this tree's build (TG_KEEP_DIGESTS=1 keeps the pins). A message with
# [skip ci] starts no pipeline.
gl_push() { # dir project branch message -> prints the sha
  local dir="$1" project="$2" branch="$3" message="$4" out f
  (
    cd "$dir" || exit 1
    [ -d .git ] || git init -q -b "$branch"
    git checkout -q -B "$branch"
    if [ -z "${TG_KEEP_DIGESTS:-}" ]; then
      for f in .gitlab/*.yml .gitlab-ci.yml; do
        if [ -f "$f" ]; then perl -pi -e 's#(ghcr\.io/intentius/terragucci-[a-z]+:[^@\s]+)\@sha256:[0-9a-f]{64}#$1#g' "$f"; fi
        # The lab's image: the tofu image with this tree's bundle (gitlab.sh image).
        if [ -f "$f" ] && [ -n "${TG_TOFU_IMAGE:-}" ]; then TG_TOFU_IMAGE="$TG_TOFU_IMAGE" perl -pi -e 's#ghcr\.io/intentius/terragucci-tofu:[^@\s"'"'"']+#$ENV{TG_TOFU_IMAGE}#g' "$f"; fi
      done
    fi
    git add -A
    git -c user.email=smoke@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -q --allow-empty -m "$message"
    if ! out="$(git push -q "${GL_URL/#http:\/\//http://oauth2:${GL_TOKEN}@}/$GL_USER/$project.git" "HEAD:refs/heads/$branch" 2>&1)"; then
      echo "${out//${GL_TOKEN}/***}" >&2; exit 1
    fi
    git rev-parse HEAD
  )
}

gl_mr() { # project branch title -> prints the merge request's iid
  glapi -X POST "$(gl_p "$1")/merge_requests" --data-urlencode "source_branch=$2" --data-urlencode "target_branch=main" \
    --data-urlencode "title=$3" | jq -r .iid
}

# The newest pipeline on SHA (from SOURCE: push, merge_request_event),
# polled until every job in it has ended. Sets PIPE_ID, PIPE_STATUS (success,
# or failed when a job failed) and PIPE_JOBS. The pipeline's own status is
# not enough: the apply jobs post terragucci/apply, which GitLab counts as one
# of the pipeline's jobs, and a wave that stopped leaves it running.
gl_wait() { # project sha [source]
  local p="" status="" jobs="" deadline=$(( $(date +%s) + GL_TIMEOUT ))
  while :; do
    p="$(glapi "$(gl_p "$1")/pipelines?sha=$2${3:+&source=$3}&order_by=id&sort=desc" | jq -c '.[0] // empty')"
    if [ -n "$p" ]; then
      status="$(jq -r .status <<<"$p")"
      jobs="$(glapi "$(gl_p "$1")/pipelines/$(jq -r .id <<<"$p")/jobs?per_page=100&include_retried=true")"
      case "$status" in success|failed|canceled|skipped) break ;; esac
      jq -e 'length > 0 and all(.[]; .status | IN("success", "failed", "canceled", "skipped", "manual"))' <<<"$jobs" >/dev/null && break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "no finished ${3:+$3 }pipeline for ${2:0:8} after ${GL_TIMEOUT}s (last status: ${status:-none})"; PIPE_STATUS=none; return 1
    fi
    sleep 4
  done
  PIPE_ID="$(jq -r .id <<<"$p")"
  PIPE_JOBS="$jobs"
  PIPE_STATUS="$status"
  case "$status" in
    success|failed|canceled|skipped) ;;
    *) if jq -e 'any(.[]; .status == "failed")' <<<"$jobs" >/dev/null; then PIPE_STATUS=failed; else PIPE_STATUS=success; fi ;;
  esac
  log "pipeline $PIPE_ID for ${2:0:8}${3:+ ($3)}: $PIPE_STATUS ($(jq -r .web_url <<<"$p" | gl_browser))"
}

gl_job() { # name -> the newest job of that name in PIPE_JOBS
  jq -r --arg n "$1" '[.[] | select(.name == $n)] | max_by(.id) | .id // empty' <<<"$PIPE_JOBS"
}

# A job's log as text: no colors, no section markers, no carriage returns.
gl_trace() { # project job
  glapi "$(gl_p "$1")/jobs/$2/trace" 2>/dev/null | sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g; s/section_(start|end):[0-9]+:[A-Za-z0-9_.-]+(\\[[^]]*\\])?\r?//g; s/\r$//'
}

gl_artifact() { # project job path -> the file from the job's artifacts
  glapi "$(gl_p "$1")/jobs/$2/artifacts/$3"
}

# Retry a job and wait for the retry to end; prints its id and status.
gl_retry() { # project job
  local new st deadline=$(( $(date +%s) + GL_TIMEOUT ))
  new="$(glapi -X POST "$(gl_p "$1")/jobs/$2/retry" | jq -r .id)" || return 1
  while :; do
    st="$(glapi "$(gl_p "$1")/jobs/$new" | jq -r .status)"
    case "$st" in success|failed|canceled|skipped) break ;; esac
    [ "$(date +%s)" -lt "$deadline" ] || { log "job $new did not end in ${GL_TIMEOUT}s"; st=none; break; }
    sleep 4
  done
  echo "$new $st"
}

gl_note() { # project iid -> the plan note's body
  glapi "$(gl_p "$1")/merge_requests/$2/notes?per_page=100" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty'
}

gl_floci_keys() { # prefix -> the keys under it in the lab's state bucket
  curl -fsS "$GL_FLOCI/shop-terraform-state?list-type=2&prefix=$1" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'
}

# One root, app, whose resource changes when rev.txt does, with its state in
# the lab's floci under the project's name, and the pipeline init writes for
# GitLab from TERRAGUCCI_YML.
gl_tree() { # dir project terragucci.yml [extra main.tf lines]
  local dir="$1" project="$2"
  mkdir -p "$dir/app"
  cat > "$dir/app/main.tf" <<TF
terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "$project/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
$( [ -z "${4:-}" ] || printf '%s\n' "$4")
}

resource "terraform_data" "probe" {
  input = trimspace(file("\${path.module}/rev.txt"))
}
TF
  echo 1 > "$dir/app/rev.txt"
  printf 'forge: gitlab\nbinary: tofu\n%b' "$3" > "$dir/terragucci.yml"
  (cd "$dir" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  [ -f "$dir/.gitlab/terragucci.yml" ] || { log "init wrote no .gitlab/terragucci.yml"; return 1; }
}

# main with no pipeline, then a branch that changes app and its merge request,
# planned. Sets MR and leaves PIPE_* on the merge request's pipeline.
gl_planned_mr() { # dir project title
  local sha
  gl_push "$1" "$2" main "smoke: main [skip ci]" >/dev/null || return 1
  echo 2 > "$1/app/rev.txt"
  sha="$(gl_push "$1" "$2" change "smoke: change app")" || return 1
  MR="$(gl_mr "$2" change "$3")"
  [ -n "$MR" ] && [ "$MR" != null ] || { log "no merge request for change"; return 1; }
  gl_wait "$2" "$sha" merge_request_event
}

# ── the claims ────────────────────────────────────────────────────────────

gitlab_claim_note_footer() {
  # A merge request's plan note on GitLab: its last line is the footer, GitLab
  # renders the footer's taco as an image, and the image answers 200 with a
  # PNG.
  # BREAK: the plan job's bundle points the footer at an image the site does
  # not serve, so the note GitLab gets has a broken taco.
  log() { echo "[smoke gitlab note-footer] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project note footer img got magic html rc=0 wf
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project note-footer)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  gl_tree "$work/tree" "$project" "gate: never\n" || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    wf="$work/tree/.gitlab/terragucci.yml"
    awk '{ print } /^plan:$/ { print "  before_script:"; print "    - \"sed -i '"'"'s#brand/taco-small.png#brand/taco-gone.png#'"'"' /usr/local/bin/terragucci\"" }' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'taco-gone' "$wf" || { log "could not break the plan job"; drop_work "$work"; return 1; }
  fi
  gl_planned_mr "$work/tree" "$project" "smoke note-footer" || rc=1
  [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "the merge request's pipeline ended $PIPE_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    note="$(gl_note "$project" "$MR")"
    [ -n "$note" ] || { log "merge request !$MR has no plan note"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    footer="$(printf '%s\n' "$note" | sed '/^[[:space:]]*$/d' | tail -1)"
    log "last line: $footer"
    [[ "$footer" == "<sub><img "*"Posted by [terragucci]("*"</sub>" ]] || { log "the note's last line is not the footer"; rc=1; }
    img="$(grep -o 'src="[^"]*"' <<<"$footer" | head -1 | sed 's/^src="//; s/"$//' || true)"
    # GitLab's own Markdown renderer, as the merge request page uses it: the
    # footer comes out as an image of that URL (lazy-loaded, so in data-src).
    html="$(glapi -X POST "$GL_URL/api/v4/markdown" -H 'content-type: application/json' \
      -d "$(jq -n --arg t "$footer" --arg p "$GL_USER/$project" '{text: $t, gfm: true, project: $p}')" | jq -r .html)"
    grep -qE "<img [^>]*(data-)?src=\"$img\"" <<<"$html" || { log "GitLab does not render the footer's image: $html"; rc=1; }
    got="$(curl -sS -m 20 -o "$work/taco.png" -w '%{http_code} %{content_type}' "$img" 2>/dev/null || true)"
    magic="$(head -c 8 "$work/taco.png" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
    log "$img answers ${got:-nothing}"
    [[ "$got" == "200 image/png"* ]] && [ "$magic" = 89504e470d0a1a0a ] || { log "the footer's image is not a PNG that answers 200"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "merge request !$MR: the note ends with the footer, GitLab renders its taco, and $img is a PNG"
  return $rc
}

gitlab_claim_tips() {
  # app's null provider is let float to "~> 3.2". The merge request's plan
  # note counts the tips, and the plan job's report.json holds as many, each
  # with its rule and an https page, terragucci-floating-range for app among
  # them.
  # BREAK: tips: false, so the note counts none and the report holds none.
  log() { echo "[smoke gitlab tips] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project cfg="gate: never\n" note counted job report tips rules rc=0
  [ -n "${BREAK:-}" ] && cfg="gate: never\ntips: false\n"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project tips)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  gl_tree "$work/tree" "$project" "$cfg" '  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }' || { drop_work "$work"; return 1; }
  gl_planned_mr "$work/tree" "$project" "smoke tips" || rc=1
  [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "the merge request's pipeline ended $PIPE_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    note="$(gl_note "$project" "$MR")"
    counted="$(sed -n 's/^\([0-9][0-9]*\) tips\{0,1\} on how the roots are set up.*/\1/p' <<<"$note" | head -1)"
    job="$(gl_job plan)"
    report="$work/report.json"
    gl_artifact "$project" "$job" terragucci-report/report.json > "$report" 2>/dev/null || : > "$report"
    tips="$(jq '[.tips // [] | .[] | select(.rule and (.url | startswith("https://")))] | length' "$report" 2>/dev/null || echo 0)"
    rules="$(jq -r '[.tips // [] | .[].rule] | unique | join(", ")' "$report" 2>/dev/null || true)"
    log "the note counts ${counted:-no} tips; the report of job $job holds ${tips:-no} with a rule and page (${rules:-none})"
    [ -n "$counted" ] && [ "${tips:-0}" -gt 0 ] && [ "$counted" = "$tips" ] || { log "the note does not count the report's tips"; rc=1; }
    jq -e '.tips[]? | select(.rule == "terragucci-floating-range" and .root == "app")' "$report" >/dev/null \
      || { log "the floating null provider in app is not tipped"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "merge request !$MR: the note counts $counted tip(s), and the report names $rules, each with its page"
  return $rc
}

gitlab_claim_apply_serial() {
  # app's apply writes a mark to floci when it starts and another when it ends,
  # 60 seconds apart, longer than the second pipeline's check job takes. A second push lands on main once the first push's apply
  # has started. The marks must read start end start end: the second apply
  # waited for the first in the resource group terragucci-apply. Both
  # pipelines pass, no job is cancelled, and the second commit's
  # terragucci/apply is one success for the stage.
  # BREAK: the resource group is cut from the pipeline and the state lock
  # waits 3 seconds, so the second apply runs into the first.
  log() { echo "[smoke gitlab apply-serial] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project wf sha1 sha2 i marks s1 s2 cancelled status rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project apply-serial)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  # The second push replaces the resource, which on-destroy would hold for an
  # approval; this claim is about the order, so no wave waits.
  gl_tree "$work/tree" "$project" "gate: never\n" || { drop_work "$work"; return 1; }
  cat >> "$work/tree/app/main.tf" <<TF

resource "terraform_data" "slow" {
  triggers_replace = file("\${path.module}/rev.txt")
  provisioner "local-exec" {
    command = <<-SH
      mark() { node -e "fetch(process.env.AWS_ENDPOINT_URL + '/shop-terraform-state/$project-marks/' + Date.now() + '-\$1', { method: 'PUT', body: 'x' })"; }
      mark start
      sleep 60
      mark end
    SH
  }
}
TF
  wf="$work/tree/.gitlab/terragucci.yml"
  grep -q '^  resource_group: terragucci-apply$' "$wf" || { log "the pipeline has no resource group for its apply jobs"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    grep -v '^  resource_group: terragucci-apply$' "$wf" \
      | awk '{ print } /^    TF_INPUT: / { print "    TF_CLI_ARGS_plan: -lock-timeout=3s"; print "    TF_CLI_ARGS_apply: -lock-timeout=3s" }' > "$wf.new" && mv "$wf.new" "$wf"
  fi
  sha1="$(gl_push "$work/tree" "$project" main "serial: first")" || rc=1
  if [ $rc = 0 ]; then
    for _ in $(seq 1 150); do
      gl_floci_keys "$project-marks/" 2>/dev/null | grep -q -- '-start$' && break
      sleep 2
    done
    gl_floci_keys "$project-marks/" | grep -q -- '-start$' || { log "the first apply never started"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/app/rev.txt"
    sha2="$(gl_push "$work/tree" "$project" main "serial: second")" || rc=1
  fi
  if [ $rc = 0 ]; then
    gl_wait "$project" "$sha1" push || rc=1
    s1="$PIPE_STATUS"; cancelled="$(jq -r '[.[] | select(.status == "canceled") | .name] | join(" ")' <<<"$PIPE_JOBS")"
    gl_wait "$project" "$sha2" push || rc=1
    s2="$PIPE_STATUS"; cancelled="$cancelled $(jq -r '[.[] | select(.status == "canceled") | .name] | join(" ")' <<<"$PIPE_JOBS")"
    marks="$(gl_floci_keys "$project-marks/" | sed -E 's#.*/[0-9]*-##' | tr '\n' ' ')"
    log "marks in key order: $marks"
    [ "$s1" = success ] && [ "$s2" = success ] || { log "the pipelines ended $s1 and $s2"; rc=1; }
    [ -z "${cancelled// /}" ] || { log "cancelled: $cancelled"; rc=1; }
    # Keys sort by millisecond timestamp, so the listing is the order they happened in.
    [ "$marks" = "start end start end " ] || { log "the applies overlapped or one did not run"; rc=1; }
    status="$(glapi "$(gl_p "$project")/repository/commits/$sha2/statuses?name=terragucci/apply&all=true" \
      | jq -r 'sort_by(.id) | map(select(.status != "running" and .status != "pending")) | map(.status + ":" + .description) | join(" | ")')"
    log "terragucci/apply on the second commit: ${status:-none}"
    [ "$status" = "success:1 roots in 1 groups applied" ] || { log "expected one success status for the stage"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the second push's apply waited for the first: $marks"
  return $rc
}

gitlab_claim_policy_override() {
  # The policy denies app's terraform_data (stack/fixtures/policy-wave's
  # plan.rego), so main's apply-wave-1 fails and records the denial on
  # chant/lifecycle. smoke-stranger, whom policy.override does not list,
  # overrides it with terragucci override; the retried job is denied again
  # and says smoke-stranger is not listed. smoke-approver, who is listed,
  # overrides it; the retried job applies app, and its report names the
  # override: who, the rules, the reason and the plan digest.
  # BREAK: policy.override lists nobody, so no override lets the wave through.
  log() { echo "[smoke gitlab policy-override] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project listed=smoke-approver sha job rules clone out first second third st report q rc=0
  local reason="smoke: the probe goes out"
  [ -n "${BREAK:-}" ] && listed=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project policy-override)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  gl_tree "$work/tree" "$project" "gate: never\n" || { drop_work "$work"; return 1; }
  mkdir -p "$work/tree/policy"
  cp "$HERE/fixtures/policy-wave/policy/plan.rego" "$work/tree/policy/"
  printf 'policy:\n  engine: conftest\n  path: policy\n' >> "$work/tree/terragucci.yml"
  [ -z "$listed" ] || printf '  override: [%s]\n' "$listed" >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed with the policy"; drop_work "$work"; return 1; }
  sha="$(gl_push "$work/tree" "$project" main "policy-override: app")" || rc=1
  [ $rc = 1 ] || gl_wait "$project" "$sha" push || rc=1
  if [ $rc = 0 ]; then
    job="$(gl_job apply-wave-1)"
    first="$(jq -r --arg j "$job" '.[] | select((.id | tostring) == $j) | .status' <<<"$PIPE_JOBS")"
    log "apply-wave-1 (job $job): $first"
    [ "$first" = failed ] || { log "the policy did not deny the wave"; rc=1; }
  fi
  # The approvers' clone: terragucci override writes to chant/lifecycle and
  # pushes it, as chant approve does.
  override_as() { # actor
    git -C "$clone" config user.name "$1"; git -C "$clone" config user.email "$1@terragucci.local"
    out="$(cd "$clone" && PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" override app --rule "$rules" --reason "$reason" --actor "$1" 2>&1)" \
      || { log "terragucci override as $1 failed: $out"; return 1; }
    log "terragucci override as $1: $(tr '\n' ' ' <<<"$out")"
  }
  if [ $rc = 0 ]; then
    clone="$work/approver"
    git clone -q "${GL_URL/#http:\/\//http://oauth2:${GL_TOKEN}@}/$GL_USER/$project.git" "$clone" || rc=1
    git -C "$clone" fetch -q origin chant/lifecycle 2>/dev/null || true
    rules="$(git -C "$clone" show origin/chant/lifecycle:_gates/policy-override.jsonl 2>/dev/null \
      | jq -rs '[.[] | select(.kind == "pending" and .gate == "app")] | last | .rules // [] | join(",")' 2>/dev/null || true)"
    log "the denial names: ${rules:-no rule}"
    [ -n "$rules" ] || { log "the wave recorded no denial of app on chant/lifecycle"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    override_as smoke-stranger || rc=1
    [ $rc = 1 ] || { read -r job second < <(gl_retry "$project" "$job"); log "retried apply-wave-1 (job $job): $second"; }
    [ "${second:-}" = failed ] || { log "the wave went through on an override by smoke-stranger"; rc=1; }
    gl_trace "$project" "$job" | grep -q "smoke-stranger is not listed under policy.override at base" \
      || { log "the job does not say smoke-stranger is not listed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    override_as smoke-approver || rc=1
    [ $rc = 1 ] || { read -r job third < <(gl_retry "$project" "$job"); log "retried apply-wave-1 (job $job): $third"; }
    [ "${third:-}" = success ] || { log "the wave did not apply after smoke-approver's override"; gl_trace "$project" "$job" | tail -20 >&2; rc=1; }
  fi
  if [ $rc = 0 ]; then
    st="$(curl -fsS "$GL_FLOCI/shop-terraform-state/$project/app.tfstate" 2>/dev/null | jq '.resources | length' 2>/dev/null || echo 0)"
    [ "${st:-0}" -gt 0 ] || { log "app has no state in floci: nothing applied"; rc=1; }
    report="$work/report.json"
    gl_artifact "$project" "$job" terragucci-report/report.json > "$report" 2>/dev/null || : > "$report"
    q='.roots[] | select(.path == "app") | .policy'
    jq -e --arg why "$reason" "$q | .result == \"denied\" and .override.by == \"smoke-approver\" and .override.reason == \$why and (.override.rules | length > 0) and (.override.plan_digest | test(\"sha256:\"))" "$report" >/dev/null \
      || { log "the report does not name the override under app: $(jq -c "$q" "$report" 2>/dev/null)"; rc=1; }
    jq -e '.policy.overridden == ["app"]' "$report" >/dev/null || { log "the report's policy does not list app as overridden"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the denied wave stayed denied after smoke-stranger's override, applied after smoke-approver's, and the report names it"
  return $rc
}
