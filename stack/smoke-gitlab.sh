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
GITLAB_CLAIMS=''

# As CLAIM_GROUPS in smoke.sh. Each run has its own project, so plain and
# break overlap. runner is the lab's one gitlab-runner (concurrent = 4):
# apply-serial's BREAK run holds it alone, so a lack of free slots never
# orders its two applies.
GITLAB_CLAIM_GROUPS=''

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
