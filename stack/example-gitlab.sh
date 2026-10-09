#!/usr/bin/env bash
#
# The example on the stack's GitLab: the shop's 15 roots, applied to floci
# through GitLab CI, with example/changes' scenarios as merge requests.
#
#   stack/example-gitlab.sh up [--fresh]
#                                     boot the gitlab profile, push the example
#                                     with the pipeline 'terragucci init --forge
#                                     gitlab' writes for it, and apply every root.
#                                     --fresh wipes floci first.
#   stack/example-gitlab.sh verify    every resource the 15 roots declare is in floci
#   stack/example-gitlab.sh change <name>
#                                     open a merge request with one scenario from
#                                     example/changes. drift deletes a queue from
#                                     floci and runs the scheduled drift pipeline.
#                                     pin is the Forgejo example's alone.
#   stack/example-gitlab.sh merge <name>
#                                     merge that scenario's merge request into main
#                                     and show which wave waits or refuses. The first
#                                     merge lists the reader's ssh key in
#                                     .chant/allowed_signers on main.
#   stack/example-gitlab.sh approve [wave-N]
#                                     approve a waiting wave as the reader, sealed
#                                     with the reader's key, then retry its job, as
#                                     the docs tell a GitLab reader to, and wait for
#                                     the pipeline. With no argument, the wave the
#                                     last pipeline on main printed an approval for.
#   stack/example-gitlab.sh comments  make the comments schedule (TERRAGUCCI_SCHEDULE
#                                     set to comments) if there is none, play it,
#                                     and show what the comments job answered: write
#                                     /terragucci plan or /terragucci apply on a merge
#                                     request first, signed in as root
#   stack/example-gitlab.sh plan-comment [name]
#                                     note /terragucci plan on the scenario's merge
#                                     request (default one-root), play the comments
#                                     schedule, and wait for the merge request
#                                     pipeline it starts, whose plan job updates
#                                     the plan note
#   stack/example-gitlab.sh pr-apply  apply before merge as the docs set it up:
#                                     main gets apply.when: pull-request with
#                                     merge: auto and the merge token, a reviewer
#                                     approves change/one-root, /terragucci apply is
#                                     noted, and the comments schedule's pipeline
#                                     on main applies and merges it ('reset' after)
#   stack/example-gitlab.sh logs      the last failed pipeline's failing lines
#   stack/example-gitlab.sh reset     close every merge request, put main back to
#                                     the example as committed, and apply it again
#   stack/example-gitlab.sh shot URL OUT.png [light|dark] [shot.mjs flags...]
#                                     one picture of a GitLab page, signed in as
#                                     root with the color mode set to light or
#                                     dark, banners and the sidebar hidden
#   stack/example-gitlab.sh capture   reset, then the docs' GitLab views, each
#                                     light and dark, as the tutorial step gitlab:
#                                     docs-site/src/data/tutorial/gitlab.json and
#                                     docs-site/src/assets/tutorial/gitlab-*.png
#   stack/example-gitlab.sh down      remove the stack
#
# TGLAB=1 runs all of it on the GitLab lab (stack/gitlab/gitlab.sh, compose
# project tglab) in place of the validation stack's gitlab profile.
#
# The project is public. GitLab's color mode is a setting of the signed-in
# user, not the browser's prefers-color-scheme, so 'shot' signs in and sets it
# before each picture.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE="$(cd "$HERE/../example" && pwd)"
TERRAGUCCI="$HERE/../node_modules/.bin/terragucci"
CMD="${1:-}"; shift || true

log()  { echo "[example-gitlab] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  || { echo "SKIP: Docker is not available, so the example cannot run."; exit 0; }

LAB="${TGLAB:-}"
if [ -n "$LAB" ]; then STATE_DIR="$HERE/gitlab/.state" FLOCI_CONTAINER=tglab-floci; else STATE_DIR="$HERE/.state" FLOCI_CONTAINER=terragucci-floci; fi

if [ "$CMD" = down ]; then
  [ -z "$LAB" ] || exec "$HERE/gitlab/gitlab.sh" down
  exec "$HERE/down.sh"
fi

FRESH=""
if [ "$CMD" = up ]; then
  for a in "$@"; do
    case "$a" in
      --fresh) FRESH=1 ;;
      *) fail "unknown flag '$a' (--fresh)" ;;
    esac
  done
  # The jobs run in terragucci's CI image. lib.sh's push_tree names it by its
  # tag alone, so the runner takes the local build of this tree.
  ref="$(cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }')"
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    log "building the CI images (a few minutes the first time)…"
    (cd "$HERE/.." && node scripts/build-cli.mjs >/dev/null && npx tsx scripts/images.ts build >/dev/null 2>&1) \
      || fail "the CI images did not build; run 'just images' to see why"
  fi
  log "starting GitLab, its runner and floci (ten minutes or more the first time under emulation)…"
  boot_log="$(mktemp)"
  boot=("$HERE/bootstrap.sh" gitlab)
  [ -z "$LAB" ] || boot=("$HERE/gitlab/gitlab.sh" up)
  if ! "${boot[@]}" >"$boot_log" 2>&1; then
    cat "$boot_log" >&2; rm -f "$boot_log"; fail "the stack did not start"
  fi
  rm -f "$boot_log"
fi

if [ -n "$LAB" ]; then
  [ -f "$STATE_DIR/gitlab.env" ] || fail "no GitLab lab; run 'just gitlab-lab up' first"
  # shellcheck disable=SC1091
  . "$STATE_DIR/gitlab.env"
  # The lab's jobs run this tree's bundle, in an image of the lab's own, and
  # leave the shared CI image tags alone (push_tree names it).
  [ -n "${TG_TOFU_IMAGE:-}" ] || TG_TOFU_IMAGE="$("$HERE/gitlab/gitlab.sh" image)" || fail "the lab's image did not build"
  export TG_TOFU_IMAGE
fi
# shellcheck source=lib.sh
# Set for the whole run, not the source alone: push_tree reads it when it pushes.
LIB_FORGE=gitlab
. "$HERE/lib.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-example-gitlab.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# glapi, pid, unprotect_all, forge_open_pr and forge_merge_pr.
# shellcheck source=forge-gitlab.sh
. "$HERE/forge-gitlab.sh"
REPO="$USER/example"
PID="$(pid example)"
P="$URL/api/v4/projects/$PID"
READER_KEY="$STATE_DIR/reader-gitlab"
# GitLab builds links from its in-network address; show the one a browser opens.
browser_url() { sed "s#^http://gitlab:8929#$URL#"; }
uri() { printf %s "$1" | jq -sRr @uri; }

# The project, public, and the CI variables the pipeline reads. GITLAB_TOKEN
# is the token the plan, apply and drift jobs call the API and push with. The
# jobs push to CI_SERVER_PROTOCOL://CI_SERVER_FQDN, which is http and
# gitlab:8929 here, so git needs no address rewrite.
ensure_project() {
  if ! api -o /dev/null "$P" 2>/dev/null; then
    api -o /dev/null -X POST "$URL/api/v4/projects" --data-urlencode "name=example" \
      --data-urlencode "description=The shop: 15 Terraform roots on floci, run by terragucci" \
      --data-urlencode "visibility=public" --data-urlencode "initialize_with_readme=false" \
      --data-urlencode "default_branch=main"
  fi
  ci_var GITLAB_TOKEN "$TOKEN" true
  # A project from an earlier driver may still carry the old rewrite.
  local v
  for v in GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; do api -o /dev/null -X DELETE "$P/variables/$v" 2>/dev/null || true; done
  # Avatars from gravatar.com would load from outside the stack.
  api -o /dev/null -X PUT "$URL/api/v4/application/settings" --data-urlencode "gravatar_enabled=false" || true
}

ci_var() { # key value [masked]
  local args=(--data-urlencode "value=$2" --data-urlencode "masked=${3:-false}" --data-urlencode "protected=false")
  api -o /dev/null -X PUT "$P/variables/$1" "${args[@]}" 2>/dev/null \
    || api -o /dev/null -X POST "$P/variables" --data-urlencode "key=$1" "${args[@]}"
}

# The example as a GitLab repo commits it: Forgejo's workflow out, forge:
# gitlab in terragucci.yml, and the pipeline 'terragucci init' writes from it:
# the jobs in .gitlab/terragucci.yml and a .gitlab-ci.yml that includes them.
gitlab_tree() { # dir (holding the example)
  rm -rf "$1/.forgejo"
  # The comments job answers /terragucci notes on the comments schedule.
  printf 'forge: gitlab\ncomments: "*/5 * * * *"\n' >> "$1/terragucci.yml"
  (cd "$1" && { [ -d .git ] || git init -q -b main; } && "$TERRAGUCCI" init >/dev/null 2>&1) \
    || fail "terragucci init failed on the example with forge: gitlab"
  [ -f "$1/.gitlab/terragucci.yml" ] || fail "terragucci init wrote no .gitlab/terragucci.yml"
  grep -q 'local: .gitlab/terragucci.yml' "$1/.gitlab-ci.yml" 2>/dev/null || fail "terragucci init wrote no .gitlab-ci.yml that includes .gitlab/terragucci.yml"
}

clone_main() { # dir
  git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$REPO.git" "$1" 2>/dev/null \
    || fail "could not clone $REPO; run 'just example-gitlab up' first"
}

# GitLab protects main a moment after the first push makes it; push_tree
# force-pushes, so lift the protection first, and once more if it came back.
gl_push() { # dir branch message -> prints the sha
  local sha
  unprotect_all example
  if sha="$(push_tree "$1" "$REPO" "$2" "$3" 2>"$WORK/push.err")"; then echo "$sha"; return 0; fi
  grep -q "protected branch" "$WORK/push.err" || { cat "$WORK/push.err" >&2; return 1; }
  sleep 2; unprotect_all example
  push_tree "$1" "$REPO" "$2" "$3"
}

# The newest pipeline on SHA (from SOURCE: push, merge_request_event,
# schedule), polled until every job in it has ended. Sets PIPE_ID, PIPE_STATUS
# (success, or failed when a job failed) and PIPE_URL.
#
# The pipeline's own status is not enough: the apply jobs post a commit status,
# terragucci/apply, which GitLab counts as one of the pipeline's jobs, and a
# wave waiting for approval leaves it running until the wave is retried.
wait_pipeline() { # sha [source]
  local sha="$1" source="${2:-}" deadline=$(( $(date +%s) + TIMEOUT )) p="" status="" jobs=""
  while :; do
    p="$(api "$P/pipelines?sha=$sha${source:+&source=$source}&order_by=id&sort=desc" | jq -c '.[0] // empty')"
    if [ -n "$p" ]; then
      status="$(jq -r .status <<<"$p")"
      case "$status" in success|failed|canceled|skipped) break ;; esac
      jobs="$(api "$P/pipelines/$(jq -r .id <<<"$p")/jobs?per_page=100")"
      jq -e 'length > 0 and all(.[]; .status | IN("success", "failed", "canceled", "skipped", "manual"))' <<<"$jobs" >/dev/null && break
    fi
    [ "$(date +%s)" -lt "$deadline" ] || fail "no finished ${source:+$source }pipeline for ${sha:0:8} after ${TIMEOUT}s (last status: ${status:-none})"
    sleep 5
  done
  PIPE_ID="$(jq -r .id <<<"$p")"
  PIPE_STATUS="$status"
  case "$status" in
    success|failed|canceled|skipped) ;;
    *) if jq -e 'any(.[]; .status == "failed")' <<<"$jobs" >/dev/null; then PIPE_STATUS=failed; else PIPE_STATUS=success; fi ;;
  esac
  PIPE_URL="$(jq -r .web_url <<<"$p" | browser_url)"
  log "pipeline $PIPE_ID for ${sha:0:8}${source:+ ($source)}: $PIPE_STATUS ($PIPE_URL)"
}

# A job's log as text: no colors, no section markers, no carriage returns.
trace() { # job id
  api "$P/jobs/$1/trace" 2>/dev/null | sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g; s/section_(start|end):[0-9]+:[A-Za-z0-9_.-]+(\\[[^]]*\\])?\r?//g; s/\r$//'
}

failed_jobs() { # pipeline id -> lines "id name"
  api "$P/pipelines/$1/jobs?scope[]=failed&per_page=100" | jq -r '.[] | "\(.id) \(.name)"'
}

print_logs() { # pipeline id
  local id name
  failed_jobs "$1" | while read -r id name; do
    echo "----- job '$name' (failed), last 60 lines -----"
    trace "$id" | tail -60
  done
}

# What a pipeline asks of the reader: the approval command a waiting wave
# printed, or the lines of a refusal.
held_lines() { # pipeline id
  local id name
  failed_jobs "$1" | while read -r id name; do
    trace "$id" | grep -E 'chant approve tf-apply wave-|changed after it was approved|planned differently since' || true
  done
}

# What a picture of a GitLab page leaves out (stack/shot.mjs --hide): the
# broadcast and callout banners, the left sidebar and the top bar's account
# menus, so the page is the project's content alone. GITLAB_STYLE lets the
# content take the sidebar's width.
GITLAB_HIDE="${GITLAB_HIDE:-.super-sidebar, .super-sidebar-toggle, .broadcast-wrapper, .gl-broadcast-message, .alert-wrapper .gl-alert, .user-callout, .js-feature-highlight}"
GITLAB_STYLE="${GITLAB_STYLE:-.page-with-super-sidebar { padding-left: 0 !important; } .top-bar-fixed { left: 0 !important; }}"

# A signed-in session for root with GitLab's color mode set to THEME, as
# NAME=VALUE for shot.mjs --cookie. The session is kept in stack/.state while
# GitLab still accepts it. The root password is the stack's, from
# docker-compose.yml.
gitlab_session() { # light|dark
  # Color mode 1 is light and 2 dark; so are the syntax themes, which code
  # blocks follow.
  local jar="$STATE_DIR/gitlab-cookies" page csrf mode=1 code
  [ "$1" = dark ] && mode=2
  code="$(curl -s -o "$WORK/prefs.html" -w '%{http_code}' -b "$jar" "$URL/-/profile/preferences" 2>/dev/null || true)"
  if [ "$code" != 200 ]; then
    rm -f "$jar"
    page="$(curl -fsS -c "$jar" -b "$jar" "$URL/users/sign_in")" || fail "the GitLab sign-in page did not load"
    csrf="$(grep -o 'name="authenticity_token" value="[^"]*"' <<<"$page" | head -1 | sed 's/.*value="//; s/"$//')"
    curl -fsS -o /dev/null -c "$jar" -b "$jar" --data-urlencode "authenticity_token=$csrf" \
      --data-urlencode "user[login]=root" --data-urlencode "user[password]=Tg9QvK3mNt8RpLb2WdHf" "$URL/users/sign_in" \
      || fail "could not sign in to GitLab as root"
    code="$(curl -s -o "$WORK/prefs.html" -w '%{http_code}' -b "$jar" "$URL/-/profile/preferences")"
    [ "$code" = 200 ] || fail "signed in, but GitLab answered $code for the preferences page"
  fi
  csrf="$(grep -o 'name="csrf-token" content="[^"]*"' "$WORK/prefs.html" | head -1 | sed 's/.*content="//; s/"$//')"
  curl -fsS -o /dev/null -b "$jar" -c "$jar" -X PUT -H "X-CSRF-Token: $csrf" -H 'Accept: application/json' \
    --data-urlencode "user[color_mode_id]=$mode" --data-urlencode "user[color_scheme_id]=$mode" \
    "$URL/-/profile/preferences" || fail "could not set the color mode to $1"
  awk '$6 == "_gitlab_session" { print $6 "=" $7 }' "$jar" | tail -1
}

# The newest pipeline with a failed job, on REF or any ref. A pipeline whose
# wave waits is still running (wait_pipeline says why), so the pipeline's own
# status cannot find it.
last_failed() { # [ref]
  local id
  for id in $(api "$P/pipelines?${1:+ref=$1&}order_by=id&sort=desc&per_page=20" | jq -r '.[].id'); do
    [ -z "$(failed_jobs "$id")" ] || { echo "$id"; return 0; }
  done
}

case "$CMD" in
  up)
    started=$(date +%s)
    if [ -n "$FRESH" ]; then
      log "wiping floci…"
      docker restart "$FLOCI_CONTAINER" >/dev/null
      until curl -s -o /dev/null "$FLOCI/"; do sleep 1; done
    fi
    ensure_project
    # The roots keep their state in this bucket; on a fresh floci, make it.
    curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
    mkdir -p "$WORK/tree"
    cp -R "$EXAMPLE/." "$WORK/tree/"
    gitlab_tree "$WORK/tree"
    sha="$(TG_FIXED_DATE=1 gl_push "$WORK/tree" main "The shop's estate")"
    api -o /dev/null -X PUT "$P" --data-urlencode "default_branch=main"
    log "pushed to main at ${sha:0:8}; the pipeline applies every root…"
    wait_pipeline "$sha" push
    if [ "$PIPE_STATUS" != success ]; then print_logs "$PIPE_ID"; fail "the pipeline ended '$PIPE_STATUS'"; fi
    verify_tree "$WORK/tree"
    log "ready in $(( $(date +%s) - started ))s"
    cat <<OUT

  The example is running on GitLab.

  GitLab      $URL/$REPO
  Pipeline    $PIPE_URL
  Sign in as  root / Tg9QvK3mNt8RpLb2WdHf (only needed to merge or comment)
  floci       $FLOCI (the AWS stand-in)

  Next: just example-gitlab change one-root
OUT
    ;;

  verify)
    clone_main "$WORK/tree"
    verify_tree "$WORK/tree"
    ;;

  change)
    name="${1:-}"
    case "$name" in
      drift)
        "$EXAMPLE/changes/drift.sh"
        # The drift job runs on a schedule. One with the example's cron runs
        # now; GitLab also runs it at that time while the stack is up.
        cron="$(sed -n 's/^drift: *"\(.*\)"/\1/p' "$EXAMPLE/terragucci.yml")"
        sched="$(api "$P/pipeline_schedules" | jq -r '.[] | select(.description == "terragucci drift") | .id' | head -1)"
        if [ -z "$sched" ]; then
          sched="$(api -X POST "$P/pipeline_schedules" --data-urlencode "description=terragucci drift" \
            --data-urlencode "ref=main" --data-urlencode "cron=$cron" --data-urlencode "active=true" | jq -r .id)"
        fi
        before="$(api "$P/pipelines?source=schedule&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
        api -o /dev/null -X POST "$P/pipeline_schedules/$sched/play"
        for _ in $(seq 1 60); do
          id="$(api "$P/pipelines?source=schedule&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
          [ "$id" -gt "$before" ] && break
          sleep 2
        done
        [ "$id" -gt "$before" ] || fail "the drift schedule started no pipeline"
        wait_pipeline "$(api "$P/pipelines/$id" | jq -r .sha)" schedule
        issue="$(api "$P/issues?state=opened&order_by=created_at&sort=desc" | jq -r '.[0].web_url // empty' | browser_url)"
        printf '\n  Drift run  %s (%s)\n  Issue      %s\n' "$PIPE_URL" "$PIPE_STATUS" "${issue:-none}"
        exit 0
        ;;
      pin) fail "the pin scenario runs on the Forgejo example only (just example change pin)" ;;
      one-root) title="Keep dev orders' unclaimed jobs for seven days" ;;
      module-bump) title="Wait 60 seconds before retrying a job, in every service" ;;
      replace) title="Key prod search's records by sku" ;;
      destroy) title="Stop keeping records for staging email" ;;
      float) title="Let dev search's AWS provider version float" ;;
      unformatted) title="Add an owner to dev orders, without running tofu fmt" ;;
      *) fail "unknown scenario '$name' (one-root, unformatted, module-bump, replace, destroy, float, drift)" ;;
    esac
    clone_main "$WORK/tree"
    git -C "$WORK/tree" apply "$EXAMPLE/changes/$name.patch" \
      || fail "changes/$name.patch does not apply to main; run 'just example-gitlab reset' first"
    sha="$(TG_FIXED_DATE=1 push_tree "$WORK/tree" "$REPO" "change/$name" "$title")"
    log "pushed change/$name at ${sha:0:8}"
    iid="$(forge_open_pr example "change/$name")"
    if [ -z "$iid" ]; then
      iid="$(api -X POST "$P/merge_requests" --data-urlencode "source_branch=change/$name" --data-urlencode "target_branch=main" \
        --data-urlencode "title=$title" --data-urlencode "description=A scenario from the terragucci example (example/changes)." | jq -r .iid)"
    fi
    mr="$URL/$REPO/-/merge_requests/$iid"
    # The branch's head has two pipelines: the merge request's, whose plan job
    # posts the plan note, and the push's, whose check job checks the format.
    wait_pipeline "$sha" merge_request_event
    plan_url="$PIPE_URL" plan_status="$PIPE_STATUS"
    wait_pipeline "$sha" push
    cat <<OUT

  Merge request  $mr (the plan note is in its activity)
  Plan           $plan_url ($plan_status)
  Check          $PIPE_URL ($PIPE_STATUS)
OUT
    ;;

  merge)
    name="${1:-}"
    [ -n "$name" ] || fail "usage: example-gitlab.sh merge <scenario>"
    iid="$(forge_open_pr example "change/$name")"
    [ -n "$iid" ] || fail "no open merge request for change/$name; run 'just example-gitlab change $name' first"
    if [ ! -f "$READER_KEY" ]; then
      mkdir -p "$(dirname "$READER_KEY")"
      ssh-keygen -q -t ed25519 -N "" -C "$USER" -f "$READER_KEY"
    fi
    line="$USER $(cut -d' ' -f1,2 "$READER_KEY.pub")"
    clone_main "$WORK/tree"
    if ! grep -qxF "$line" "$WORK/tree/.chant/allowed_signers" 2>/dev/null; then
      mkdir -p "$WORK/tree/.chant"
      echo "$line" >> "$WORK/tree/.chant/allowed_signers"
      sha="$(gl_push "$WORK/tree" main "List the reader's key in .chant/allowed_signers")"
      log "listed the reader's key in .chant/allowed_signers"
      wait_pipeline "$sha" push
    fi
    forge_merge_pr example "$iid"
    sha="$(remote_head "$REPO" main)"
    log "merged change/$name into main"
    wait_pipeline "$sha" push
    printf '\n  Merged    merge request !%s into main\n  Pipeline  %s (%s)\n' "$iid" "$PIPE_URL" "$PIPE_STATUS"
    held_lines "$PIPE_ID" | sed 's/^/  /'
    ;;

  approve)
    pipe="$(last_failed main)"
    wave="${1:-}"
    if [ -z "$wave" ] && [ -n "$pipe" ]; then
      wave="$(held_lines "$pipe" | grep -o 'chant approve tf-apply wave-[0-9]*' | head -1 | sed 's/.*tf-apply //' || true)"
    fi
    [ -n "$wave" ] || fail "no wave is waiting; run 'just example-gitlab change destroy' and 'just example-gitlab merge destroy' first"
    [ -f "$READER_KEY" ] || fail "the reader's key is listed by 'just example-gitlab merge'; merge a scenario first"
    clone_main "$WORK/approve"
    git -C "$WORK/approve" config user.name "$USER"
    git -C "$WORK/approve" config user.email "$USER@terragucci.local"
    out="$(cd "$WORK/approve" && "$HERE/../node_modules/.bin/chant" approve tf-apply "$wave" --actor "$USER" --sign "$READER_KEY" 2>&1)" \
      || { echo "$out" >&2; fail "chant approve tf-apply $wave failed"; }
    printf '\n  Approved  %s, signed as %s\n' "$wave" "$USER"
    # GitLab has no comment command: the reader retries the waiting job.
    job="$( [ -z "$pipe" ] || api "$P/pipelines/$pipe/jobs?scope[]=failed" | jq -r --arg n "apply-$wave" '.[] | select(.name == $n) | .id' | head -1)"
    [ -n "$job" ] || { log "no failed apply-$wave job on main's last failed pipeline; retry it by hand"; exit 0; }
    new="$(api -X POST "$P/jobs/$job/retry" | jq -r .id)"
    log "retried apply-$wave (job $new)"
    deadline=$(( $(date +%s) + TIMEOUT ))
    until case "$(api "$P/jobs/$new" | jq -r .status)" in success|failed|canceled|skipped) true ;; *) false ;; esac; do
      [ "$(date +%s)" -lt "$deadline" ] || fail "job $new did not finish in ${TIMEOUT}s"
      sleep 5
    done
    # The jobs after it run once it passes, and the last wave's success ends
    # terragucci/apply, so the pipeline itself ends. Wait for that, or for a
    # later wave to stop again.
    if [ "$(api "$P/jobs/$new" | jq -r .status)" = success ]; then
      ended() {
        case "$(api "$P/pipelines/$pipe" | jq -r .status)" in success|failed|canceled) return 0 ;; esac
        api "$P/pipelines/$pipe/jobs?per_page=100" \
          | jq -e 'all(.[]; .status | IN("success", "failed", "canceled", "skipped", "manual")) and any(.[]; .status == "failed")' >/dev/null
      }
      until ended; do
        [ "$(date +%s)" -lt "$deadline" ] || fail "pipeline $pipe did not end in ${TIMEOUT}s"
        sleep 5
      done
    fi
    wait_pipeline "$(api "$P/pipelines/$pipe" | jq -r .sha)" push
    printf '  Retried   %s/-/jobs/%s\n  Pipeline  %s (%s)\n' "$URL/$REPO" "$new" "$PIPE_URL" "$PIPE_STATUS"
    held_lines "$PIPE_ID" | sed 's/^/  /'
    if [ "$PIPE_STATUS" = success ]; then clone_main "$WORK/tree"; verify_tree "$WORK/tree"; fi
    ;;

  comments)
    # Merge request notes start no pipeline on GitLab: the comments schedule's
    # pipeline reads them. One with the example's cron is made once and runs
    # every five minutes while the stack is up; this plays it now.
    cron="$(cd "$WORK" && clone_main tree && sed -n 's/^comments: *"\(.*\)"/\1/p' tree/terragucci.yml)"
    [ -n "$cron" ] || fail "main's terragucci.yml sets no comments schedule; run 'just example-gitlab reset' first"
    sched="$(api "$P/pipeline_schedules" | jq -r '.[] | select(.description == "terragucci comments") | .id' | head -1)"
    if [ -z "$sched" ]; then
      sched="$(api -X POST "$P/pipeline_schedules" --data-urlencode "description=terragucci comments" \
        --data-urlencode "ref=main" --data-urlencode "cron=$cron" --data-urlencode "active=true" | jq -r .id)"
      api -o /dev/null -X POST "$P/pipeline_schedules/$sched/variables" --data-urlencode "key=TERRAGUCCI_SCHEDULE" --data-urlencode "value=comments"
      log "made the comments schedule ($cron, TERRAGUCCI_SCHEDULE=comments)"
    fi
    before="$(api "$P/pipelines?source=schedule&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
    # GitLab plays a schedule once a minute at most.
    for _ in $(seq 1 7); do api -o /dev/null -X POST "$P/pipeline_schedules/$sched/play" 2>/dev/null && break; sleep 10; done
    id="$before"
    for _ in $(seq 1 60); do
      id="$(api "$P/pipelines?source=schedule&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
      [ "$id" -gt "$before" ] && break
      sleep 2
    done
    [ "$id" -gt "$before" ] || fail "the comments schedule started no pipeline"
    wait_pipeline "$(api "$P/pipelines/$id" | jq -r .sha)" schedule
    job="$(api "$P/pipelines/$PIPE_ID/jobs" | jq -r '.[] | select(.name == "comments") | .id' | head -1)"
    [ -n "$job" ] || fail "pipeline $PIPE_ID has no comments job"
    printf '\n  Comments run  %s (%s)\n' "$PIPE_URL" "$PIPE_STATUS"
    trace "$job" | grep '^terragucci comment:' | sed 's/^/  /' || true
    ;;

  plan-comment)
    name="${1:-one-root}"
    iid="$(forge_open_pr example "change/$name")"
    [ -n "$iid" ] || fail "no open merge request for change/$name; run 'just example-gitlab change $name' first"
    before="$(api "$P/pipelines?source=merge_request_event&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
    api -o /dev/null -X POST "$P/merge_requests/$iid/notes" --data-urlencode "body=/terragucci plan" || fail "could not note /terragucci plan on !$iid"
    log "noted /terragucci plan on !$iid"
    "$0" comments >&2 || fail "the comments schedule failed"
    id="$before"
    for _ in $(seq 1 60); do
      id="$(api "$P/pipelines?source=merge_request_event&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
      [ "$id" -gt "$before" ] && break
      sleep 2
    done
    [ "$id" -gt "$before" ] || fail "the comments job started no merge request pipeline for !$iid"
    wait_pipeline "$(api "$P/pipelines/$id" | jq -r .sha)" merge_request_event
    printf '\n  Merge request  %s/%s/-/merge_requests/%s (the plan note is updated in place)\n  Re-plan        %s (%s)\n' "$URL" "$REPO" "$iid" "$PIPE_URL" "$PIPE_STATUS"
    ;;

  pr-apply)
    # main applies merge requests before they merge, with the merge token in a
    # variable that only the terragucci-merge environment's jobs read.
    clone_main "$WORK/tree"
    printf 'apply:\n  when: pull-request\n  merge: auto\n  merge_token_env: TERRAGUCCI_MERGE_TOKEN\n' >> "$WORK/tree/terragucci.yml"
    (cd "$WORK/tree" && "$TERRAGUCCI" init >/dev/null 2>&1) || fail "terragucci init failed with apply.when: pull-request"
    grep -q '^mr-apply:$' "$WORK/tree/.gitlab/terragucci.yml" || fail "the pipeline init wrote has no mr-apply job"
    sha="$(gl_push "$WORK/tree" main "Apply merge requests before they merge")"
    wait_pipeline "$sha" push
    api -o /dev/null -X DELETE "$P/variables/TERRAGUCCI_MERGE_TOKEN?filter%5Benvironment_scope%5D=terragucci-merge" 2>/dev/null || true
    api -o /dev/null -X POST "$P/variables" --data-urlencode "key=TERRAGUCCI_MERGE_TOKEN" --data-urlencode "value=$TOKEN" \
      --data-urlencode "environment_scope=terragucci-merge" --data-urlencode "protected=false" --data-urlencode "masked=true" \
      || fail "could not set TERRAGUCCI_MERGE_TOKEN"
    # A reviewer other than the merge request's author approves its head.
    uid="$(api "$URL/api/v4/users?username=reviewer" | jq -r '.[0].id // empty')"
    if [ -z "$uid" ]; then
      uid="$(api -X POST "$URL/api/v4/users" --data-urlencode "username=reviewer" --data-urlencode "name=Reviewer" \
        --data-urlencode "email=reviewer@terragucci.local" --data-urlencode "password=Tg$(openssl rand -hex 16)!Zq" \
        --data-urlencode "skip_confirmation=true" | jq -r '.id // empty')"
    fi
    [ -n "$uid" ] || fail "could not make the reviewer"
    api -o /dev/null -X POST "$P/members" --data-urlencode "user_id=$uid" --data-urlencode "access_level=30" 2>/dev/null || true
    rtok="$(api -X POST "$URL/api/v4/users/$uid/personal_access_tokens" --data-urlencode "name=reviewer-$RANDOM" --data-urlencode "scopes[]=api" \
      --data-urlencode "expires_at=$(date -v+2d +%Y-%m-%d 2>/dev/null || date -d '+2 days' +%Y-%m-%d)" | jq -r '.token // empty')"
    [ -n "$rtok" ] || fail "no token for the reviewer"
    "$0" change one-root >&2 || fail "change one-root failed"
    iid="$(forge_open_pr example change/one-root)"
    [ -n "$iid" ] || fail "no merge request for change/one-root"
    head="$(api "$P/merge_requests/$iid" | jq -r .sha)"
    sleep 2
    curl -fsS -o /dev/null -H "PRIVATE-TOKEN: $rtok" -X POST "$P/merge_requests/$iid/approve" || fail "the reviewer could not approve !$iid"
    log "reviewer approved !$iid at ${head:0:8}"
    before="$(api "$P/pipelines?source=api&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
    api -o /dev/null -X POST "$P/merge_requests/$iid/notes" --data-urlencode "body=/terragucci apply" || fail "could not note /terragucci apply on !$iid"
    log "noted /terragucci apply on !$iid"
    "$0" comments >&2 || fail "the comments schedule failed"
    id="$before"
    for _ in $(seq 1 60); do
      id="$(api "$P/pipelines?source=api&order_by=id&sort=desc" | jq -r '.[0].id // 0')"
      [ "$id" -gt "$before" ] && break
      sleep 2
    done
    [ "$id" -gt "$before" ] || fail "the comments job started no pipeline on main for !$iid"
    wait_pipeline "$(api "$P/pipelines/$id" | jq -r .sha)" api
    state="$(api "$P/merge_requests/$iid" | jq -r .state)"
    printf '\n  Merge request  %s/%s/-/merge_requests/%s (%s)\n  Apply          %s (%s)\n' "$URL" "$REPO" "$iid" "$state" "$PIPE_URL" "$PIPE_STATUS"
    api "$P/merge_requests/$iid/notes?sort=asc&per_page=100" | jq -r '.[] | select(.body | startswith("terragucci:")) | .body' \
      | sed -E 's/<!--.*-->//g; /^[[:space:]]*$/d; s/^/  /'
    [ "$state" = merged ] || fail "!$iid was not merged after /terragucci apply"
    ;;

  logs)
    pipe="$(last_failed)"
    [ -n "$pipe" ] || { log "no failed pipeline"; exit 0; }
    failed_jobs "$pipe" | while read -r id name; do
      echo "----- $name -----"
      trace "$id" | grep -vE '^(Running with|Preparing|Using docker|Pulling|Getting source|Fetching|Created fresh|Checking out|Skipping|Executing|Uploading|Cleaning up|\$ )' | tail -30
    done
    ;;

  reset)
    for iid in $(api "$P/merge_requests?state=opened&per_page=100" | jq -r '.[].iid'); do
      api -o /dev/null -X PUT "$P/merge_requests/$iid" --data-urlencode "state_event=close"
    done
    # chant/lifecycle, the approvals and the scenario branches go too.
    for b in $(api "$P/repository/branches?per_page=100" | jq -r '.[].name | select(. != "main")'); do
      api -o /dev/null -X DELETE "$P/repository/branches/$(uri "$b")" || true
    done
    for i in $(api "$P/issues?state=opened&per_page=100" | jq -r '.[].iid'); do
      api -o /dev/null -X PUT "$P/issues/$i" --data-urlencode "state_event=close" || true
    done
    clone_main "$WORK/tree"
    find "$WORK/tree" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    cp -R "$EXAMPLE/." "$WORK/tree/"
    gitlab_tree "$WORK/tree"
    sha="$(gl_push "$WORK/tree" main "Reset to the example as committed")"
    wait_pipeline "$sha" push
    if [ "$PIPE_STATUS" != success ]; then print_logs "$PIPE_ID"; fail "the pipeline ended '$PIPE_STATUS'"; fi
    verify_tree "$WORK/tree"
    ;;

  shot)
    url="${1:-}"; out="${2:-}"; theme="${3:-light}"
    [ -n "$url" ] && [ -n "$out" ] || fail "usage: example-gitlab.sh shot URL OUT.png [light|dark] [shot.mjs flags...]"
    shift $(( $# < 3 ? $# : 3 ))
    case "$url" in http*) ;; *) url="$URL/${url#/}" ;; esac
    CHROME="${CHROME:-}"
    if [ -z "$CHROME" ]; then
      for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome chromium chromium-browser; do
        if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME="$c"; break; fi
      done
    fi
    [ -n "$CHROME" ] || fail "no Chrome or Chromium found; set CHROME"
    cookie="$(gitlab_session "$theme")"
    node "$HERE/shot.mjs" --chrome "$CHROME" --url "$url" --out "$out" --scheme "$theme" \
      --cookie "$cookie" --hide "$GITLAB_HIDE" --style "$GITLAB_STYLE" "$@"
    log "wrote $out ($theme)"
    ;;

  capture)
    # Each step runs as its own command, so what it prints is what a reader
    # of the docs would see, and each view is shot right after its step.
    ROOT="$(cd "$HERE/.." && pwd)"
    DATA="$ROOT/docs-site/src/data/tutorial" SHOTS="$ROOT/docs-site/src/assets/tutorial"
    started="$(date +%s)"
    "$0" reset >&2 || fail "reset failed; run 'just example-gitlab up' first"
    mkdir -p "$WORK/shots"
    : > "$WORK/commands"
    step() { # command words...
      local out
      out="$("$0" "$@")" || return 1
      jq -n --arg cmd "just example-gitlab $*" --arg output "$(sed '/^$/d; s/^  //' <<<"$out")" '{cmd: $cmd, output: $output, exit: 0}' >> "$WORK/commands"
    }
    # A job's log, which a signed-out reader cannot open: its lines from the
    # first that matches one regex to the first after it that matches another.
    log_lines() { # command, job id, from regex, to regex, exit code
      local out
      out="$(trace "$2" | awk -v a="$3" -v b="$4" '!on && $0 ~ a { on = 1 } on { sub(/[ \t]+$/, ""); print } on && $0 ~ b { exit }')"
      [ -n "$out" ] || fail "no lines from /$3/ in job $2"
      jq -n --arg cmd "$1" --arg output "$out" --argjson exit "$5" '{cmd: $cmd, output: $output, exit: $exit}' >> "$WORK/commands"
    }
    take() { # view path [shot.mjs flags...]
      local view="$1" path="$2" scheme
      shift 2
      for scheme in light dark; do "$0" shot "$path" "$WORK/shots/$view-$scheme.png" "$scheme" "$@" >&2 || fail "no $scheme picture of $view"; done
    }
    # The setting the add-to page asks a GitLab reader to turn on.
    api -o /dev/null -X PUT "$P" --data-urlencode "only_allow_merge_if_pipeline_succeeds=true"
    take required "/$REPO/-/settings/merge_requests" --scroll '.gl-form-checkbox, .form-check' --match 'Pipelines must succeed' --height 420

    step change one-root || fail "change one-root failed"
    iid="$(forge_open_pr example change/one-root)"
    take note "/$REPO/-/merge_requests/$iid" --scroll 'li.note' --match 'Posted by' --fit 1
    # The re-plan updates that note in place; the picture runs on to the note below it.
    step plan-comment one-root || fail "plan-comment one-root failed"
    take replan "/$REPO/-/merge_requests/$iid" --scroll 'li.note' --match 'Posted by' --height 1200

    step change unformatted || fail "change unformatted failed"
    # The check job's fix moves the branch, so its first push pipeline is the one that failed.
    pipe="$(api "$P/pipelines?ref=change%2Funformatted&source=push&order_by=id&sort=asc" | jq -r '.[0].id // empty')"
    job="$( [ -z "$pipe" ] || api "$P/pipelines/$pipe/jobs?scope[]=failed" | jq -r '.[] | select(.name == "check") | .id' | head -1)"
    [ -n "$job" ] || fail "no failed check job on change/unformatted"
    take check "/$REPO/-/jobs/$job" --scroll '.js-line, .log-line' --match 'unformatted|owner' --height 860
    log_lines "the check job of change/unformatted" "$job" '^envs/.*[.]tf$' 'Cleaning up|ERROR: Job failed' 1

    step change destroy || fail "change destroy failed"
    step merge destroy || fail "merge destroy failed"
    pipe="$(last_failed main)"
    job="$( [ -z "$pipe" ] || api "$P/pipelines/$pipe/jobs?scope[]=failed" | jq -r '.[] | select(.name | startswith("apply-wave-")) | .id' | head -1)"
    [ -n "$job" ] || fail "no waiting wave on main after merge destroy"
    take waiting "/$REPO/-/jobs/$job" --scroll '.js-line, .log-line' --match 'chant approve tf-apply' --height 860
    log_lines "the waiting apply job on main" "$job" '^wave [0-9]+ of [0-9]+:' 'chant approve tf-apply' 3

    # Drift comes last: the queue it deletes would be applied back by any later merge.
    step change drift || fail "change drift failed"
    issue="$(api "$P/issues?state=opened&order_by=created_at&sort=desc" | jq -r '.[0].iid // empty')"
    [ -n "$issue" ] || fail "the drift run opened no issue"
    take drift "/$REPO/-/issues/$issue" --height 860

    # Apply before merge changes main's pipeline, so it runs on a reset example.
    "$0" reset >&2 || fail "reset failed"
    step pr-apply || fail "pr-apply failed"
    iid="$(api "$P/merge_requests?state=merged&source_branch=change%2Fone-root&order_by=updated_at" | jq -r '.[0].iid // empty')"
    [ -n "$iid" ] || fail "no merged merge request from change/one-root"
    take apply "/$REPO/-/merge_requests/$iid" --scroll 'li.note' --match 'applied wave' --height 420

    # The hash tutorial-check computes, as every capture records it.
    hash="$(cd "$ROOT" && node scripts/tutorial-check.mjs --hash)"
    shots='{}'
    for view in required note replan check waiting drift apply; do
      for scheme in light dark; do
        cp "$WORK/shots/$view-$scheme.png" "$SHOTS/gitlab-$view-$scheme.png"
        h="$(shasum -a 256 "$SHOTS/gitlab-$view-$scheme.png" | cut -c1-16)"
        shots="$(jq --arg k "$view-$scheme" --arg h "$h" '. + {($k): $h}' <<<"$shots")"
      done
    done
    # GitLab's address depends on the stack it ran on; the docs show the path.
    U="$URL" perl -pi -e 's#\Q$ENV{U}\E##g' "$WORK/commands"
    jq -s --arg h "$hash" --argjson shots "$shots" '{step: "gitlab", source_hash: $h, commands: ., shots: $shots}' \
      "$WORK/commands" > "$DATA/gitlab.json"
    api -o /dev/null -X PUT "$P" --data-urlencode "only_allow_merge_if_pipeline_succeeds=false"
    "$0" reset >&2
    printf '\n  Wrote  docs-site/src/data/tutorial/gitlab.json and docs-site/src/assets/tutorial/gitlab-*.png\n  Took   %s minutes\n' \
      "$(( ($(date +%s) - started + 59) / 60 ))"
    ;;

  *)
    sed -n '3,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
