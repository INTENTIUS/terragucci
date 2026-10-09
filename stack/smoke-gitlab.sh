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
policy-override|a wave the policy denies is retried with no effect after an override by someone policy.override does not list, applies after the listed approver overrides its plan, and its report names the override|
mr-widget|the Terraform widget of a merge request counts the creates, updates and deletes of the plan job report, a replacement as a create and a delete|
managed-state-parallelism|roots on GitLab-managed state apply at most 3 at once, and the apply job says so|
report-keys|with the bucket keys in CI/CD variables, which the pipeline maps nowhere, the plan job writes report.json to the bucket and the index lists the run|
report-oidc|with no static keys, the plan job assumes reports.role with its OIDC token from id_tokens, writes report.json to the bucket, and the index lists the run|
drift-issue|the drift schedule opens one drift issue naming the root and attribute that drifted, updates the same issue when more drifts, and closes it when a run finds none|
estate-job|the estate job of the see-every-project page, pasted into .gitlab-ci.yml and run by a pipeline schedule with only its OIDC token, writes estate.html listing the project to the bucket and prints a presigned link|
explain-refusal|after a wave is refused, the explain-refusal job of the agent-refused-wave page runs wave-refused on the wave reports and a stand-in agent prints a summary naming the root whose plan moved, and a branch pipeline still runs|
publish|the publish job pushes a git tag for each changed module on a merge to main, none when no module changed, and the next version for a changed module|
rollout|a module version rolls out one merge request per wave, each changing only its roots and opened only after the last wave merged and applied|
reconcile-mixed|a control repo with projects on GitLab and Forgejo opens the merge request of the GitLab project, names the Forgejo project that failed, and exits 1|'

# As CLAIM_GROUPS in smoke.sh. Each run has its own project, so plain and
# break overlap. runner is the lab's one gitlab-runner (concurrent = 4):
# apply-serial's BREAK run holds it alone, so a lack of free slots never
# orders its two applies.
GITLAB_CLAIM_GROUPS='
note-footer      runner weight=100
tips             runner weight=100
apply-serial     runner break:runner! weight=300
policy-override  runner weight=250
mr-widget        runner weight=150
managed-state-parallelism runner weight=150
report-keys      runner weight=100
report-oidc      runner weight=100
drift-issue      runner weight=300
estate-job       runner weight=150
explain-refusal  runner weight=250
publish          runner weight=250
rollout          runner weight=500
reconcile-mixed  weight=60
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

# ── more helpers ──────────────────────────────────────────────────────────

# A project CI/CD variable, replaced when it is there. An empty value hides
# the runner's own variable of that name from every job.
gl_var() { # project key value
  glapi -o /dev/null -X DELETE "$(gl_p "$1")/variables/$2" 2>/dev/null || true
  glapi -o /dev/null -X POST "$(gl_p "$1")/variables" --data-urlencode "key=$2" --data-urlencode "value=$3" \
    --data-urlencode "protected=false" --data-urlencode "masked=false"
}

# A pipeline schedule on main, with TERRAGUCCI_SCHEDULE set when a value is
# given. Its cron is far off: the claim plays it.
gl_schedule() { # project description [TERRAGUCCI_SCHEDULE] -> prints its id
  local sid
  sid="$(glapi -X POST "$(gl_p "$1")/pipeline_schedules" --data-urlencode "description=$2" --data-urlencode "ref=main" \
    --data-urlencode "cron=0 0 1 1 *" --data-urlencode "active=true" | jq -r '.id // empty')"
  [ -n "$sid" ] || { log "could not make the $2 schedule"; return 1; }
  if [ -n "${3:-}" ]; then
    glapi -o /dev/null -X POST "$(gl_p "$1")/pipeline_schedules/$sid/variables" --data-urlencode "key=TERRAGUCCI_SCHEDULE" --data-urlencode "value=$3" || return 1
  fi
  echo "$sid"
}

# PIPE_ID, PIPE_STATUS and PIPE_JOBS for one pipeline, once every job in it
# has ended, as gl_wait.
gl_await() { # project pipeline-id
  local p status jobs deadline=$(( $(date +%s) + GL_TIMEOUT ))
  while :; do
    p="$(glapi "$(gl_p "$1")/pipelines/$2")"
    status="$(jq -r .status <<<"$p")"
    jobs="$(glapi "$(gl_p "$1")/pipelines/$2/jobs?per_page=100&include_retried=true")"
    case "$status" in success|failed|canceled|skipped) break ;; esac
    jq -e 'length > 0 and all(.[]; .status | IN("success", "failed", "canceled", "skipped", "manual"))' <<<"$jobs" >/dev/null && break
    if [ "$(date +%s)" -ge "$deadline" ]; then log "pipeline $2 did not end in ${GL_TIMEOUT}s (last status: $status)"; PIPE_STATUS=none; return 1; fi
    sleep 4
  done
  PIPE_ID="$2"; PIPE_JOBS="$jobs"; PIPE_STATUS="$status"
  case "$status" in
    success|failed|canceled|skipped) ;;
    *) if jq -e 'any(.[]; .status == "failed")' <<<"$jobs" >/dev/null; then PIPE_STATUS=failed; else PIPE_STATUS=success; fi ;;
  esac
  log "pipeline $2: $PIPE_STATUS ($(jq -r .web_url <<<"$p" | gl_browser))"
}

# Play a schedule and wait for the pipeline it starts. GitLab plays one
# schedule once a minute at most, so a play it refuses is tried again.
gl_play() { # project schedule-id
  local before id="" i
  before="$(glapi "$(gl_p "$1")/pipelines?source=schedule&order_by=id&sort=desc&per_page=1" | jq -r '.[0].id // 0')"
  for i in $(seq 1 10); do
    glapi -o /dev/null -X POST "$(gl_p "$1")/pipeline_schedules/$2/play" 2>/dev/null && break
    sleep 10
  done
  for i in $(seq 1 60); do
    id="$(glapi "$(gl_p "$1")/pipelines?source=schedule&order_by=id&sort=desc&per_page=1" | jq -r '.[0].id // 0')"
    [ "$id" -gt "$before" ] && break
    sleep 3
  done
  [ "$id" -gt "$before" ] || { log "playing schedule $2 started no pipeline"; PIPE_STATUS=none; return 1; }
  gl_await "$1" "$id"
}

# The YAML block of a docs page's GitLab tab, as a reader copies it.
gl_page_snippet() { # page under docs-site/src/content/docs
  awk '/<TabItem label="GitLab">/ { tab = 1; next } tab && /^ *```yaml/ { code = 1; match($0, /^ */); cut = RLENGTH; next }
       code && /^ *```/ { exit } code { print substr($0, cut + 1) }' "$HERE/../docs-site/src/content/docs/$1"
}

# The keys under a prefix in a bucket of the lab's floci.
gl_bucket_keys() { # bucket prefix
  curl -fsS "$GL_FLOCI/$1?list-type=2&prefix=$2" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'
}

# ── the claims of the site-claims audit (#362) ────────────────────────────

gitlab_claim_mr_widget() {
  # main applies app's probe, gone and swap. A merge request updates probe,
  # removes gone, replaces swap and adds fresh. GitLab's Terraform widget on
  # the merge request, read from the endpoint its page reads, counts 2
  # creates, 1 update and 2 deletes, and so does the plan job's report.json
  # (a replacement is a create and a delete).
  # BREAK: the plan job's reports:terraform artifact is cut, so the widget
  # has no counts.
  log() { echo "[smoke gitlab mr-widget] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project wf sha job report want got i rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project mr-widget)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  gl_tree "$work/tree" "$project" "gate: never\n" || { drop_work "$work"; return 1; }
  printf '\nresource "terraform_data" "gone" {\n  input = "gone"\n}\n\nresource "terraform_data" "swap" {\n  triggers_replace = "1"\n}\n' >> "$work/tree/app/main.tf"
  if [ -n "${BREAK:-}" ]; then
    wf="$work/tree/.gitlab/terragucci.yml"
    awk '/^    reports:$/ { skip = 1; next } skip && /^      terraform:/ { skip = 0; next } { skip = 0; print }' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'gitlab-terraform.json' "$wf" && { log "could not cut the terraform report"; drop_work "$work"; return 1; }
  fi
  sha="$(gl_push "$work/tree" "$project" main "mr-widget: main")" || rc=1
  [ $rc = 1 ] || gl_wait "$project" "$sha" push || rc=1
  [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "main's pipeline ended $PIPE_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/app/rev.txt"
    perl -0pi -e 's/\nresource "terraform_data" "gone" \{\n  input = "gone"\n\}\n//; s/triggers_replace = "1"/triggers_replace = "2"/' "$work/tree/app/main.tf"
    printf '\nresource "terraform_data" "fresh" {\n  input = "fresh"\n}\n' >> "$work/tree/app/main.tf"
    sha="$(gl_push "$work/tree" "$project" change "mr-widget: change app")" || rc=1
  fi
  if [ $rc = 0 ]; then
    MR="$(gl_mr "$project" change "smoke mr-widget")"
    gl_wait "$project" "$sha" merge_request_event || rc=1
    [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "the merge request's pipeline ended $PIPE_STATUS"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    job="$(gl_job plan)"
    report="$work/report.json"
    gl_artifact "$project" "$job" terragucci-report/report.json > "$report" 2>/dev/null || : > "$report"
    want="$(jq -c '.totals | {create: (.create + .replace), update: .update, delete: (.delete + .replace)}' "$report" 2>/dev/null || true)"
    # GitLab parses the report in the background and answers 204 until then.
    for i in $(seq 1 30); do
      got="$(glapi "$GL_URL/$GL_USER/$project/-/merge_requests/$MR/terraform_reports.json" 2>/dev/null \
        | jq -c '[.[]] | if length == 0 then empty else (first | {create, update, delete}) end' 2>/dev/null || true)"
      [ -n "$got" ] && break
      sleep 2
    done
    log "the widget of !$MR counts ${got:-nothing}; the report of job $job counts ${want:-nothing}"
    [ "$want" = '{"create":2,"update":1,"delete":2}' ] || { log "report.json does not count 2 creates, 1 update and 2 deletes"; rc=1; }
    [ -n "$got" ] && [ "$got" = "$want" ] || { log "the widget's counts are not the report's"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "merge request !$MR: the Terraform widget counts $got, as report.json does"
  return $rc
}

gitlab_claim_managed_state_parallelism() {
  # Five roots, r1 to r5, each on GitLab-managed state: an http backend at the
  # project's terraform/state/<root>, with the job token as its password. Each
  # root's apply marks in floci when it starts and when it ends, 20 seconds
  # apart. main's apply-wave-1 says it runs up to 3 roots at once for
  # GitLab-managed state, and the marks show 3 applying at once and never more.
  # BREAK: parallelism: 5 in terragucci.yml, so all five apply at once.
  log() { echo "[smoke gitlab managed-state-parallelism] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project pid r st sha job most n k rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project managed-state-parallelism)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  pid="$(glapi "$(gl_p "$project")" | jq -r .id)"
  for r in r1 r2 r3 r4 r5; do
    st="http://gitlab:8929/api/v4/projects/$pid/terraform/state/$r"
    mkdir -p "$work/tree/$r"
    cat > "$work/tree/$r/main.tf" <<TF
terraform {
  backend "http" {
    address        = "$st"
    lock_address   = "$st/lock"
    unlock_address = "$st/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    username       = "gitlab-ci-token"
  }
}

resource "terraform_data" "slow" {
  provisioner "local-exec" {
    command = <<-SH
      mark() { node -e "fetch(process.env.AWS_ENDPOINT_URL + '/shop-terraform-state/$project-marks/' + Date.now() + '-$r-\$1', { method: 'PUT', body: 'x' })"; }
      mark start
      sleep 20
      mark end
    SH
  }
}
TF
  done
  # shellcheck disable=SC2016 # GitLab expands it in the job
  printf 'forge: gitlab\nbinary: tofu\ngate: never\nenv:\n  TF_HTTP_PASSWORD: "${CI_JOB_TOKEN}"\n' > "$work/tree/terragucci.yml"
  [ -z "${BREAK:-}" ] || printf 'parallelism: 5\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  sha="$(gl_push "$work/tree" "$project" main "managed-state-parallelism: five roots")" || rc=1
  [ $rc = 1 ] || gl_wait "$project" "$sha" push || rc=1
  [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "main's pipeline ended $PIPE_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    job="$(gl_job apply-wave-1)"
    gl_trace "$project" "$job" | grep -E 'roots at once' | sed 's/^/  /' >&2 || true
    gl_trace "$project" "$job" | grep -q 'up to 3 roots at once (GitLab-managed state rate-limits concurrent inits)' \
      || { log "apply-wave-1 does not say it runs up to 3 roots at once for GitLab-managed state"; rc=1; }
    # Keys sort by millisecond timestamp, so the listing is the order the marks were made in.
    most=0; n=0
    while read -r k; do
      case "$k" in *-start) n=$((n + 1)); [ "$n" -gt "$most" ] && most=$n ;; *-end) n=$((n - 1)) ;; esac
    done < <(gl_floci_keys "$project-marks/")
    log "$(gl_floci_keys "$project-marks/" | grep -c -- '-end$') roots applied, at most $most at once"
    [ "$(gl_floci_keys "$project-marks/" | grep -c -- '-end$')" = 5 ] || { log "not every root applied"; rc=1; }
    [ "$most" = 3 ] || { log "the roots applied $most at once, not 3"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "five roots on GitLab-managed state applied 3 at a time"
  return $rc
}

# A project of one root, app, on a local backend, whose terragucci.yml sets
# reports to a bucket of the lab's floci under the project's name.
gl_report_tree() { # dir project extra-yaml
  mkdir -p "$1/app"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "probe" {\n  input = trimspace(file("${path.module}/rev.txt"))\n}\n' > "$1/app/main.tf"
  echo 1 > "$1/app/rev.txt"
  printf 'forge: gitlab\nbinary: tofu\ngate: never\nreports:\n  bucket: s3://tg-reports\n  endpoint: http://floci:4566\n  prefix: %s\n%b' "$2" "$3" > "$1/terragucci.yml"
  curl -fsS -o /dev/null -X PUT "$GL_FLOCI/tg-reports" 2>/dev/null || true
  (cd "$1" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
}

# The index under the project's prefix lists the merge request's head, and
# its report.json is in the bucket.
gl_report_landed() { # project head
  local index path
  index="$(curl -fsS "$GL_FLOCI/tg-reports/$1/index.json" 2>/dev/null || true)"
  [ -n "$index" ] || { log "no index at tg-reports/$1/index.json"; return 1; }
  path="$(jq -r --arg c "$2" '[.reports[] | select(.commit == $c) | .path] | first // empty' <<<"$index")"
  [ -n "$path" ] || { log "the index does not list ${2:0:8}: $(jq -c '[.reports[].commit]' <<<"$index")"; return 1; }
  curl -fsS "$GL_FLOCI/tg-reports/$1/$path/report.json" 2>/dev/null | jq -e --arg c "$2" '.run.commit == $c' >/dev/null \
    || { log "no report.json of ${2:0:8} at tg-reports/$1/$path"; return 1; }
  log "the index lists ${2:0:8}, and its report.json is at tg-reports/$1/$path"
}

gitlab_claim_report_keys() {
  # reports.bucket is a bucket in the lab's floci, and the project's CI/CD
  # variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY hold its keys,
  # which the pipeline maps nowhere: the job reads them as they are. The
  # merge request's plan job writes report.json to the bucket, and the index
  # lists the run.
  # BREAK: the variables are empty, so the job has no keys and writes nothing.
  log() { echo "[smoke gitlab report-keys] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project key=smoke-reports secret=smoke-reports-secret rc=0
  [ -n "${BREAK:-}" ] && key="" secret=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project report-keys)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  gl_var "$project" AWS_ACCESS_KEY_ID "$key" && gl_var "$project" AWS_SECRET_ACCESS_KEY "$secret" || { drop_work "$work"; return 1; }
  gl_report_tree "$work/tree" "$project" "" || { drop_work "$work"; return 1; }
  grep -q 'AWS_ACCESS_KEY_ID' "$work/tree/.gitlab/terragucci.yml" && { log "the pipeline maps AWS_ACCESS_KEY_ID itself"; rc=1; }
  [ $rc = 1 ] || gl_planned_mr "$work/tree" "$project" "smoke report-keys" || rc=1
  [ $rc = 1 ] || gl_report_landed "$project" "$(git -C "$work/tree" rev-parse HEAD)" || rc=1
  [ $rc = 0 ] || gl_trace "$project" "$(gl_job plan)" | grep -iE 'bucket|report' | tail -5 >&2 || true
  drop_work "$work"
  [ $rc = 0 ] && log "with the keys in CI/CD variables, the plan job wrote report.json and the index"
  return $rc
}

gitlab_claim_report_oidc() {
  # oidc names the plan and apply roles, reports.role a role that writes
  # reports, and the project's AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are
  # empty: the job has no static keys. The merge request's plan job takes its
  # OIDC token from id_tokens, assumes reports.role with it through floci's
  # STS, writes report.json to the bucket, and the index lists the run.
  # BREAK: oidc is cut, so the job has no token to assume reports.role with.
  log() { echo "[smoke gitlab report-oidc] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project oidc rc=0
  oidc='oidc:\n  plan_role: arn:aws:iam::000000000000:role/terragucci-plan\n  apply_role: arn:aws:iam::000000000000:role/terragucci-apply\n'
  [ -n "${BREAK:-}" ] && oidc=""
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project report-oidc)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  gl_var "$project" AWS_ACCESS_KEY_ID "" && gl_var "$project" AWS_SECRET_ACCESS_KEY "" || { drop_work "$work"; return 1; }
  gl_report_tree "$work/tree" "$project" "  role: arn:aws:iam::000000000000:role/terragucci-reports\n$oidc" || { drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] || grep -q '^  id_tokens:' "$work/tree/.gitlab/terragucci.yml" || { log "the pipeline asks for no OIDC token"; rc=1; }
  [ $rc = 1 ] || gl_planned_mr "$work/tree" "$project" "smoke report-oidc" || rc=1
  [ $rc = 1 ] || gl_report_landed "$project" "$(git -C "$work/tree" rev-parse HEAD)" || rc=1
  [ $rc = 0 ] || gl_trace "$project" "$(gl_job plan)" | grep -iE 'bucket|report|role' | tail -5 >&2 || true
  drop_work "$work"
  [ $rc = 0 ] && log "with no static keys, the plan job assumed reports.role with its OIDC token and wrote report.json and the index"
  return $rc
}

gl_sqs() { curl -fsS -X POST "$GL_FLOCI/" -H "X-Amz-Target: AmazonSQS.$1" -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; }

gitlab_claim_drift_issue() {
  # main's pipeline applies a queue with a visibility timeout of 30. In floci,
  # outside OpenTofu, the timeout goes to 45, and the drift schedule's
  # pipeline opens the project's drift issue naming app and the timeout. The
  # retention moves too, and the next run updates that issue, still the only
  # one, to name both. Both go back, and the third run closes it.
  # BREAK: the retention stays moved, so the third run still finds drift and
  # the issue stays open.
  log() { echo "[smoke gitlab drift-issue] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project queue sha sid url iid body st job rc=0 back=345600
  [ -n "${BREAK:-}" ] && back=86400
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project drift-issue)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  queue="$project"
  mkdir -p "$work/tree/app"
  # The queue carries a tag: floci reads an untagged queue's tags as {} where
  # the state holds null, a tags drift no run clears.
  respond_root "$project/app.tfstate" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
  tags                       = { owner = \"smoke\" }
}" > "$work/tree/app/main.tf"
  cp "$EXAMPLE/envs/dev/orders/.terraform.lock.hcl" "$work/tree/app/"
  printf 'forge: gitlab\nbinary: tofu\ngate: never\ndrift: "0 3 * * *"\nrespond:\n  drift: "off"\n' > "$work/tree/terragucci.yml"
  (cd "$work/tree" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  sha="$(gl_push "$work/tree" "$project" main "drift-issue: a queue with a timeout of 30")" || rc=1
  [ $rc = 1 ] || gl_wait "$project" "$sha" push || rc=1
  [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "main's pipeline ended $PIPE_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    url="$(gl_sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
    [ -n "$url" ] || { log "$queue is not in floci"; rc=1; }
  fi
  [ $rc = 1 ] || sid="$(gl_schedule "$project" drift)" || rc=1
  drift_issues() { glapi "$(gl_p "$project")/issues?state=$1&per_page=100" | jq -c '[.[] | select((.description // "") | contains("<!-- terragucci:drift -->"))]'; }
  attrs() { gl_sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"$1\",\"MessageRetentionPeriod\":\"$2\"}}" >/dev/null; }
  drift_run() { # what the job must say
    gl_play "$project" "$sid" || return 1
    job="$(gl_job drift)"
    [ "$PIPE_STATUS" = success ] || { log "the drift pipeline ended $PIPE_STATUS"; return 1; }
    gl_trace "$project" "$job" | grep -E '^drift issue ' | sed 's/^/  /' >&2 || true
    gl_trace "$project" "$job" | grep -q "^drift issue $1: " || { log "the drift job did not say the issue was $1"; return 1; }
  }
  if [ $rc = 0 ]; then
    attrs 45 345600
    drift_run opened || rc=1
    iid="$(drift_issues opened | jq -r '.[0].iid // empty')"
    body="$(drift_issues opened | jq -r '.[0].description // empty')"
    [ -n "$iid" ] || { log "the first run opened no drift issue"; rc=1; }
    grep -q '`app`' <<<"$body" && grep -q 'visibility_timeout_seconds' <<<"$body" || { log "the drift issue does not name app and the timeout"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    attrs 45 86400
    drift_run updated || rc=1
    body="$(drift_issues opened | jq -r --arg i "$iid" '.[] | select((.iid | tostring) == $i) | .description')"
    [ "$(drift_issues opened | jq length)" = 1 ] || { log "the second run left $(drift_issues opened | jq length) drift issues open"; rc=1; }
    grep -q 'message_retention_seconds' <<<"$body" || { log "issue #$iid was not updated to name the retention"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    attrs 30 "$back"
    drift_run closed || rc=1
    st="$(glapi "$(gl_p "$project")/issues/$iid" | jq -r .state)"
    [ "$st" = closed ] || { log "drift issue #$iid is $st after a run with no drift"; rc=1; }
  fi
  [ -z "${url:-}" ] || gl_sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "drift issue #$iid opened for the timeout, updated for the retention, and closed by the run that found none"
  return $rc
}

gitlab_claim_estate_job() {
  # A project whose merge request's plan job writes its report to a bucket
  # with the keys in CI/CD variables. Then the keys are emptied, and the
  # estate job of see-every-project's GitLab tab, pasted as it is into
  # .gitlab-ci.yml, runs from a pipeline schedule: with only its OIDC token
  # and the role it names, it writes estate.html and estate.json, which lists
  # the project, to the bucket and prints a presigned link to the page.
  # BREAK: the job asks for no id_tokens, so it has no token for the role.
  log() { echo "[smoke gitlab estate-job] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project snippet sid job rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project estate-job)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  gl_var "$project" AWS_ACCESS_KEY_ID smoke-reports && gl_var "$project" AWS_SECRET_ACCESS_KEY smoke-reports-secret || { drop_work "$work"; return 1; }
  gl_report_tree "$work/tree" "$project" "" || { drop_work "$work"; return 1; }
  snippet="$(gl_page_snippet guides/see-every-project.mdx)"
  grep -q '^estate:$' <<<"$snippet" && grep -q 'terragucci estate' <<<"$snippet" || { log "no estate job in the page's GitLab tab"; drop_work "$work"; return 1; }
  # floci keeps each account's buckets apart: the role is floci's account's.
  snippet="$(sed 's#arn:aws:iam::123456789012:#arn:aws:iam::000000000000:#' <<<"$snippet")"
  if [ -n "${BREAK:-}" ]; then
    snippet="$(awk '/^  id_tokens:$/ { skip = 1; next } skip && /^    / { next } { skip = 0; print }' <<<"$snippet")"
    grep -q id_tokens <<<"$snippet" && { log "could not cut id_tokens"; drop_work "$work"; return 1; }
  fi
  # The page's steps: the job in a file of its own, named by own_jobs, and init again.
  mkdir -p "$work/tree/ci"
  printf '%s\n' "$snippet" > "$work/tree/ci/own-jobs.yml"
  printf 'own_jobs: ci/own-jobs.yml\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init with own_jobs failed"; drop_work "$work"; return 1; }
  grep -q '^explain-refusal:$' "$work/tree/.gitlab/terragucci.yml" || { log "init did not write the job into the pipeline"; drop_work "$work"; return 1; }
  gl_planned_mr "$work/tree" "$project" "smoke estate-job" || rc=1
  [ $rc = 1 ] || gl_report_landed "$project" "$(git -C "$work/tree" rev-parse HEAD)" || rc=1
  if [ $rc = 0 ]; then
    # From here the job has no static keys: the runner's are hidden too.
    gl_var "$project" AWS_ACCESS_KEY_ID "" && gl_var "$project" AWS_SECRET_ACCESS_KEY "" || rc=1
    # The schedule runs main's pipeline, which has the estate job only once main has it.
    gl_push "$work/tree" "$project" main "estate-job: the estate job [skip ci]" >/dev/null || rc=1
  fi
  [ $rc = 1 ] || sid="$(gl_schedule "$project" estate)" || rc=1
  [ $rc = 1 ] || gl_play "$project" "$sid" || rc=1
  if [ $rc = 0 ]; then
    job="$(gl_job estate)"
    [ -n "$job" ] || { log "the schedule's pipeline has no estate job"; rc=1; }
    gl_trace "$project" "$job" | grep -E 'estate|https?://' | tail -4 | sed 's/^/  /' >&2 || true
    [ "$PIPE_STATUS" = success ] || { log "the estate pipeline ended $PIPE_STATUS"; rc=1; }
    gl_trace "$project" "$job" | grep -q 'estate.html?.*X-Amz-Signature=' || { log "the job printed no presigned link to estate.html"; rc=1; }
    gl_bucket_keys tg-reports "$project/" | grep -qx "$project/estate.html" || { log "no estate.html at tg-reports/$project/"; rc=1; }
    curl -fsS "$GL_FLOCI/tg-reports/$project/estate.json" 2>/dev/null | grep -q "$project" || { log "estate.json does not list the project"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the page's estate job ran on its schedule with only its OIDC token and wrote estate.html, listing $project"
  return $rc
}

gitlab_claim_explain_refusal() {
  # Two roots, a (the canary, wave 1) and b (wave 2), and the explain-refusal
  # job of agent-refused-wave's GitLab tab in ci/own-jobs.yml, which own_jobs
  # names and init writes into the pipeline, with a stand-in for Claude Code ahead of it on the PATH:
  # it reads refusal.json and prints the roots in it. A change replaces b's
  # resource, so wave 2 waits; smoke-approver approves it; another change
  # moves b's plan, and wave 2 is refused. The job runs after the refusal,
  # and its log has the stand-in's summary naming b. A branch's pipeline,
  # which has no apply-wave-2, still runs.
  # BREAK: the job reads the reports from reports/, as the GitHub and Forgejo
  # tabs do, where GitLab unpacks none.
  log() { echo "[smoke gitlab explain-refusal] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project snippet r sha job clone out summary rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project explain-refusal)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  for r in a b; do
    mkdir -p "$work/tree/$r"
    printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "%s/%s.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "probe" {\n  triggers_replace = trimspace(file("${path.module}/rev.txt"))\n}\n' "$project" "$r" > "$work/tree/$r/main.tf"
    echo 1 > "$work/tree/$r/rev.txt"
  done
  printf 'forge: gitlab\nbinary: tofu\nwaves:\n  canary: ["a"]\n' > "$work/tree/terragucci.yml"
  (cd "$work/tree" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  grep -q '^apply-wave-2:$' "$work/tree/.gitlab/terragucci.yml" || { log "the pipeline has no apply-wave-2"; drop_work "$work"; return 1; }
  snippet="$(gl_page_snippet guides/agent-refused-wave.mdx)"
  grep -q '^explain-refusal:$' <<<"$snippet" || { log "no explain-refusal job in the page's GitLab tab"; drop_work "$work"; return 1; }
  [ -z "${BREAK:-}" ] || snippet="$(sed 's#terragucci-report/#reports/#g' <<<"$snippet")"
  # The stand-in: npx runs it for @anthropic-ai/claude-code and anything else as npx does.
  snippet="$(awk '{ print } /^explain-refusal:$/ {
    print "  before_script:"
    print "    - |"
    print "      mv /usr/local/bin/npx /usr/local/bin/npx-real"
    print "      printf \"%s\\n\" \"#!/bin/sh\" \"case \\\"\\$*\\\" in *@anthropic-ai/claude-code@*) exec node /usr/local/bin/stand-in-agent.cjs ;; esac\" \"exec npx-real \\\"\\$@\\\"\" > /usr/local/bin/npx"
    print "      chmod +x /usr/local/bin/npx"
    print "      cat > /usr/local/bin/stand-in-agent.cjs <<'"'"'JS'"'"'"
    print "      const d = JSON.parse(require(\"node:fs\").readFileSync(\"refusal.json\", \"utf8\"));"
    print "      const roots = new Set();"
    print "      (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === \"object\") { if (typeof x.root === \"string\") roots.add(x.root); Object.values(x).forEach(walk); } })(d);"
    print "      console.log(\"stand-in agent: since the approval the plans of \" + ([...roots].join(\", \") || \"no root\") + \" moved\");"
    print "      JS"
  }' <<<"$snippet")"
  printf '\n%s\n' "$snippet" >> "$work/tree/.gitlab-ci.yml"
  run_main() { # message -> waits for main's pipeline
    sha="$(gl_push "$work/tree" "$project" main "$1")" || return 1
    gl_wait "$project" "$sha" push
  }
  run_main "explain-refusal: a and b" || rc=1
  [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "the first pipeline ended $PIPE_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/b/rev.txt"
    run_main "explain-refusal: replace b" || rc=1
    job="$(gl_job apply-wave-2)"
    gl_trace "$project" "$job" | grep -q 'chant approve tf-apply wave-2' || { log "wave 2 did not wait for an approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    clone="$work/approver"
    git clone -q "${GL_URL/#http:\/\//http://oauth2:${GL_TOKEN}@}/$GL_USER/$project.git" "$clone" || rc=1
    git -C "$clone" config user.name smoke-approver; git -C "$clone" config user.email smoke-approver@terragucci.local
    out="$(cd "$clone" && PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" approve --actor smoke-approver 2>&1)" || { echo "$out" >&2; log "terragucci approve failed"; rc=1; }
    [ $rc = 1 ] || log "terragucci approve: $(tail -1 <<<"$out")"
  fi
  if [ $rc = 0 ]; then
    echo 3 > "$work/tree/b/rev.txt"
    run_main "explain-refusal: move b's plan" || rc=1
    job="$(gl_job apply-wave-2)"
    [ "$(jq -r --arg j "$job" '.[] | select((.id | tostring) == $j) | .status' <<<"$PIPE_JOBS")" = failed ] || { log "wave 2 was not refused"; rc=1; }
    gl_trace "$project" "$job" | grep -qiE 'refus' || { log "wave 2's job does not say it was refused"; rc=1; }
    job="$(gl_job explain-refusal)"
    [ -n "$job" ] || { log "no explain-refusal job ran"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    summary="$(gl_trace "$project" "$job" | grep '^stand-in agent:' | tail -1 || true)"
    log "explain-refusal (job $job): ${summary:-no summary}"
    [ "$(jq -r --arg j "$job" '.[] | select((.id | tostring) == $j) | .status' <<<"$PIPE_JOBS")" = success ] || { gl_trace "$project" "$job" | tail -15 >&2; log "the explain-refusal job failed"; rc=1; }
    grep -q 'the plans of b moved' <<<"$summary" || { log "the summary does not name b"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # A branch's pipeline has no apply-wave-2, and the job must not need it there.
    echo "a branch" > "$work/tree/NOTES.md"
    sha="$(gl_push "$work/tree" "$project" change "explain-refusal: a branch")" || rc=1
    [ $rc = 1 ] || gl_wait "$project" "$sha" push || rc=1
    [ $rc = 1 ] || { [ "$PIPE_STATUS" = success ] && [ "$(jq length <<<"$PIPE_JOBS")" -gt 0 ]; } \
      || { log "the branch's pipeline ended ${PIPE_STATUS:-none} with $(jq length <<<"${PIPE_JOBS:-[]}") jobs: the job breaks pipelines without apply-wave-2"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "after wave 2 was refused, the page's job ran wave-refused on its reports and the stand-in agent summarized: $summary"
  return $rc
}

gitlab_claim_publish() {
  # modules.publish is git-tags. The first push to main publishes
  # modules/service and modules/queue: the pipeline's publish job pushes
  # modules/service/v0.1.0 and modules/queue/v0.1.0 to the project. A push
  # that changes no module pushes no tag, and a change to service alone
  # pushes modules/service/v0.2.0.
  # BREAK: the release tags are deleted from the project between pushes, so
  # the git-tags target has no record of the release and publishes it again.
  log() { echo "[smoke gitlab publish] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project tree remote before t rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project publish)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  tree="$work/tree"; remote="${GL_URL/#http:\/\//http://oauth2:${GL_TOKEN}@}/$GL_USER/$project.git"
  mkdir -p "$tree/modules/service" "$tree/modules/queue" "$tree/envs/dev"
  printf 'resource "terraform_data" "service" {}\n' > "$tree/modules/service/main.tf"
  printf 'resource "terraform_data" "queue" {}\n' > "$tree/modules/queue/main.tf"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "%s/dev.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "dev" {}\n' "$project" > "$tree/envs/dev/main.tf"
  printf 'forge: gitlab\nbinary: tofu\ngate: never\nmodules:\n  path: modules/*\n  publish: git-tags\n' > "$tree/terragucci.yml"
  (cd "$tree" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  grep -q '^publish:$' "$tree/.gitlab/terragucci.yml" || { log "init wrote no publish job"; drop_work "$work"; return 1; }
  gittags() { git ls-remote --tags "$remote" 'refs/tags/modules/*' | sed -E 's#.*refs/tags/##; /\^\{\}$/d' | sort | paste -sd, -; }
  run() { # message: push to main and wait for its pipeline
    local sha
    sha="$(gl_push "$tree" "$project" main "$1")" || return 1
    gl_wait "$project" "$sha" push || return 1
    [ "$PIPE_STATUS" = success ] || { gl_trace "$project" "$(gl_job publish)" | tail -15 >&2; log "the pipeline for '$1' ended $PIPE_STATUS"; return 1; }
    gl_trace "$project" "$(gl_job publish)" | grep -E 'modules/' | sed 's/^/  /' >&2 || true
  }
  run "feat: modules" || rc=1
  if [ $rc = 0 ]; then
    [ "$(gittags)" = "modules/queue/v0.1.0,modules/service/v0.1.0" ] || { log "first merge: the project has tags '$(gittags)'"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    if [ -n "${BREAK:-}" ]; then
      for t in $(gittags | tr ',' ' '); do git -C "$tree" push -q "$remote" ":refs/tags/$t"; done
    fi
    before="$(gittags)"
    run "chore: nothing changed" || rc=1
    [ $rc = 1 ] || [ "$(gittags)" = "$before" ] || { log "a push that changed no module pushed tags: '$before' became '$(gittags)'"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    printf 'output "id" { value = terraform_data.service.id }\n' > "$tree/modules/service/outputs.tf"
    run "feat(service): an id output" || rc=1
    [ $rc = 1 ] || [ "$(gittags)" = "modules/queue/v0.1.0,modules/service/v0.1.0,modules/service/v0.2.0" ] || { log "after a change to service the project has tags '$(gittags)'"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the publish job pushed both modules' tags on the first merge, none on a merge that changed no module, and modules/service/v0.2.0 for a change to service"
  return $rc
}

gitlab_claim_rollout() {
  # One project, three roots taking modules/network by git tag: dev/app (the
  # canary), prod/net, and prod/app, which reads prod/net's state. The module
  # changes and its publish job tags 0.2.0. terragucci rollout, run against
  # the project, finds 0.2.0, then opens at most one wave's merge request per
  # run, changing only that wave's root, and never opens a wave before the
  # last one merged and its apply passed on the merge commit.
  # BREAK: the opening runs are dry runs, so no merge request opens.
  log() { echo "[smoke gitlab rollout] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project tree remote source mode=apply out rc=0 wave mr sha n files i st
  local expect=("" "dev/app/main.tf" "prod/net/main.tf" "prod/app/main.tf")
  [ -n "${BREAK:-}" ] && mode=dry-run
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project rollout)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  tree="$work/tree"; remote="${GL_URL/#http:\/\//http://oauth2:${GL_TOKEN}@}/$GL_USER/$project.git"
  source="git::http://gitlab:8929/$GL_USER/$project.git//modules/network?ref=modules/network/v0.1.0"
  mkdir -p "$tree/modules/network" "$tree/dev/app" "$tree/prod/net" "$tree/prod/app"
  printf 'variable "name" {}\n\noutput "name" {\n  value = var.name\n}\n' > "$tree/modules/network/main.tf"
  root() { # dir, state key, extra
    printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "%s/%s.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\n%bmodule "network" {\n  source = "%s"\n  name   = "%s"\n}\n\noutput "name" {\n  value = module.network.name\n}\n' "$project" "$2" "$3" "$source" "$2" > "$tree/$1/main.tf"
  }
  root dev/app dev-app ""
  root prod/net prod-net ""
  root prod/app prod-app "data \"terraform_remote_state\" \"net\" {\n  backend = \"s3\"\n  config = {\n    bucket         = \"shop-terraform-state\"\n    key            = \"$project/prod-net.tfstate\"\n    region         = \"us-east-1\"\n    use_path_style = true\n  }\n}\n\n"
  printf 'forge: gitlab\nbinary: tofu\ngate: never\nurl: %s/%s/%s\nwaves:\n  canary: ["dev/*"]\nmodules:\n  path: modules/*\n  publish: git-tags\n' "$GL_URL" "$GL_USER" "$project" > "$tree/terragucci.yml"
  (cd "$tree" && git init -q -b main && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  # The first commit and its tag go up together: the roots read the module at that tag.
  ( cd "$tree" && git remote add origin "$remote" && git add -A \
    && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat: three roots on modules/network 0.1.0" \
    && git -c user.name=terragucci -c user.email=t@t tag -a modules/network/v0.1.0 -m "modules/network 0.1.0" \
    && git push -q origin refs/tags/modules/network/v0.1.0 main ) 2>/dev/null || { log "could not push the project"; drop_work "$work"; return 1; }
  gl_wait "$project" "$(git -C "$tree" rev-parse HEAD)" push || rc=1
  [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "the first pipeline ended $PIPE_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    printf '\noutput "version" {\n  value = "0.2.0"\n}\n' >> "$tree/modules/network/main.tf"
    ( cd "$tree" && git add -A && git -c user.name=terragucci -c user.email=t@t -c commit.gpgsign=false commit -q -m "feat(network): a version output" \
      && git push -q origin main ) 2>/dev/null || rc=1
    [ $rc = 1 ] || gl_wait "$project" "$(git -C "$tree" rev-parse HEAD)" push || rc=1
    [ $rc = 1 ] || [ "$PIPE_STATUS" = success ] || { log "the module change's pipeline ended $PIPE_STATUS"; rc=1; }
    git -C "$tree" fetch -q --tags origin 2>/dev/null || true
    [ $rc = 1 ] || git -C "$tree" rev-parse -q --verify refs/tags/modules/network/v0.2.0 >/dev/null || { log "the publish job did not tag modules/network/v0.2.0"; rc=1; }
  fi
  ro() { (cd "$tree" && GITLAB_TOKEN="$GL_TOKEN" "$TERRAGUCCI" rollout modules/network "$@" 2>&1); }
  if [ $rc = 0 ]; then
    out="$(ro)" || { echo "$out" >&2; rc=1; }
    echo "$out" | sed 's/^/  /' >&2
    grep -q "modules/network 0.1.0 -> 0.2.0 (newest published: tag modules/network/v0.2.0): would-open" <<<"$out" \
      || { log "the dry run did not find 0.2.0 on its own"; rc=1; }
  fi
  mr_for() { glapi "$(gl_p "$project")/merge_requests?state=all&source_branch=$(gl_uri "terragucci/rollout/modules-network-0.2.0/wave-$1")" | jq -r '.[0].iid // empty'; }
  for wave in 1 2 3; do
    [ $rc = 0 ] || break
    out="$(ro --mode "$mode")"
    echo "$out" | sed 's/^/  /' >&2
    mr="$(mr_for "$wave")"
    [ -n "$mr" ] || { log "wave $wave: no merge request opened"; rc=1; break; }
    # GitLab works out a new merge request's diff in the background.
    for i in $(seq 1 20); do
      files="$(glapi "$(gl_p "$project")/merge_requests/$mr/diffs" | jq -r '[.[].new_path] | join(",")')"
      [ -n "$files" ] && break
      sleep 2
    done
    [ "$files" = "${expect[$wave]}" ] || { log "wave $wave's merge request !$mr changes '$files', not ${expect[$wave]}"; rc=1; break; }
    # Open: the next run waits and opens nothing.
    out="$(ro --mode "$mode")"; n=$?
    [ $n = 3 ] && [ -z "$(mr_for $((wave + 1)))" ] || { echo "$out" >&2; log "wave $wave open: exit $n, or the next wave opened"; rc=1; break; }
    for i in $(seq 1 30); do
      st="$(glapi -X PUT "$(gl_p "$project")/merge_requests/$mr/merge" 2>/dev/null | jq -r '.state // empty' || true)"
      [ "$st" = merged ] && break
      sleep 3
    done
    [ "$st" = merged ] || { log "could not merge !$mr"; rc=1; break; }
    sha="$(glapi "$(gl_p "$project")/merge_requests/$mr" | jq -r '.merge_commit_sha // .sha')"
    # Merged, apply not yet passed: still nothing opens.
    out="$(ro --mode "$mode")"
    if [ -n "$(mr_for $((wave + 1)))" ]; then
      n="$(glapi "$(gl_p "$project")/repository/commits/$sha/statuses?name=terragucci/apply&all=true" | jq -r 'max_by(.id) | .status // "none"')"
      [ "$n" = success ] || { echo "$out" >&2; log "wave $((wave + 1)) opened while wave $wave's apply was '$n'"; rc=1; break; }
    fi
    gl_wait "$project" "$sha" push || { rc=1; break; }
    [ "$PIPE_STATUS" = success ] || { log "wave $wave's apply ended $PIPE_STATUS"; rc=1; break; }
    log "wave $wave: !$mr changed ${expect[$wave]}, merged, applied"
  done
  if [ $rc = 0 ]; then
    out="$(ro --mode "$mode")"; n=$?
    echo "$out" | sed 's/^/  /' >&2
    [ $n = 0 ] && grep -q ": complete" <<<"$out" || { log "after three waves the rollout is not complete (exit $n)"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "0.2.0 found from its tag; three waves, one merge request each moving only its root, each opened only after the last applied"
  return $rc
}

gitlab_claim_reconcile_mixed() {
  # A control repo whose projects are on two forges: a GitLab project on the
  # lab with one root and no pipeline, and a Forgejo project whose forge does
  # not answer. terragucci reconcile --mode apply opens the GitLab project's
  # merge request with the pipeline init writes for GitLab, fails the Forgejo
  # project and names it, and exits 1.
  # BREAK: the GitLab project is listed as forge: forgejo, so reconcile
  # speaks Forgejo's API to GitLab and opens no merge request there.
  log() { echo "[smoke gitlab reconcile-mixed] $*" >&2; }
  gl_load || return 1
  build_cli || return 1
  local work project forge=gitlab out n mr files rc=0
  [ -n "${BREAK:-}" ] && forge=forgejo
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  project="$(gl_project reconcile-mixed)" || { drop_work "$work"; return 1; }
  log "project $GL_URL/$GL_USER/$project"
  mkdir -p "$work/tree/app" "$work/control"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "probe" {}\n' > "$work/tree/app/main.tf"
  gl_push "$work/tree" "$project" main "reconcile-mixed: one root, no pipeline" >/dev/null || { drop_work "$work"; return 1; }
  cat > "$work/control/terragucci.yml" <<YML
defaults:
  binary: tofu
projects:
  localhost/$GL_USER/$project:
    forge: $forge
    url: $GL_URL/$GL_USER/$project
  forgejo.invalid/smoke/$project:
    forge: forgejo
    url: http://127.0.0.1:9/smoke/$project
YML
  out="$(cd "$work/control" && GITLAB_TOKEN="$GL_TOKEN" FORGEJO_TOKEN=smoke-no-forge "$TERRAGUCCI" reconcile --config terragucci.yml --mode apply 2>&1)"; n=$?
  echo "$out" | sed 's/^/  /' >&2
  [ "$n" = 1 ] || { log "reconcile exited $n, not 1"; rc=1; }
  grep -q "^forgejo.invalid/smoke/$project: FAILED " <<<"$out" || { log "reconcile did not name the Forgejo project as failed"; rc=1; }
  mr="$(glapi "$(gl_p "$project")/merge_requests?state=opened&source_branch=terragucci%2Fpipeline" | jq -r '.[0].iid // empty')"
  [ -n "$mr" ] || { log "no merge request from terragucci/pipeline in the GitLab project"; rc=1; }
  if [ -n "$mr" ]; then
    for _ in $(seq 1 20); do
      files="$(glapi "$(gl_p "$project")/merge_requests/$mr/diffs" | jq -r '[.[].new_path] | sort | join(",")')"
      [ -n "$files" ] && break
      sleep 2
    done
    log "!$mr changes $files"
    grep -q '.gitlab/terragucci.yml' <<<"$files" && grep -q '.gitlab-ci.yml' <<<"$files" || { log "the merge request does not add GitLab's pipeline"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "one control repo, two forges: GitLab got !$mr with its pipeline, the unreachable Forgejo project failed by name, and reconcile exited 1"
  return $rc
}
