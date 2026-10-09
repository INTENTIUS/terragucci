#!/usr/bin/env bash
#
# Claims on the github and gitlab profiles, run with the pipeline terragucci
# generates for the forge rather than a hand-written one. validate.sh hands
# over here for those forges, and for the forgejo profile's tg-* and cdf-*
# claims (its check and apply run validate.sh's hand-written workflow).
#
#   stack/validate-generated.sh github check
#   stack/validate-generated.sh gitlab apply
#   stack/validate-generated.sh github reconcile
#   stack/validate-generated.sh gitlab tg-check
#   BREAK=1 stack/validate-generated.sh gitlab check    must fail
#
#   check      the fmt check passes a formatted root and fails an unformatted
#              one, with the file named in the job log.
#   apply      with the bucket deleted from floci first, a push to main goes
#              green and the bucket then exists when asked from the host.
#   reconcile  terragucci reconcile --mode apply on a control repo of two
#              projects: the one with no pipeline gets one pull (merge)
#              request, the one already in line is left alone, the request's
#              check goes green, and merged, its pipeline applies both roots
#              in order (app reads network's state).
#   tg-check   check, on a Terragrunt repo (fixtures/terragrunt-buckets: two
#              units, an implicit stack): the pipeline init writes runs in the
#              terragrunt image, and an unformatted .hcl file in a unit fails
#              it with the file named.
#   tg-apply   apply, on the same repo: both units' buckets exist afterwards.
#   cdf-check  check, on a choudoufu estate (fixtures/choudoufu-estate): the
#              pipeline runs in the choudoufu image, and a resource whose
#              lifecycle ignores its tags, which live-check refuses, fails it
#              with the resource named.
#   cdf-apply  apply, on the same estate: the bucket exists afterwards and
#              carries the estate marker choudoufu writes.
#   gate-wait  gitlab only: with the gate at always, a push to main waits at
#              wave 1. The pipeline ends (failed), the wave's job ends with
#              exit code 3 and prints chant approve, no status call is
#              refused, terragucci/apply is failed with the wave's command,
#              and the bucket does not exist.
#   own-jobs   gitlab only: a repo with its own .gitlab-ci.yml (one job, no
#              stage). init adds the include of .gitlab/terragucci.yml and
#              keeps the job; a push to a branch goes green, the repo's job
#              runs in the test stage, and terragucci's check runs beside it.
#   pr-review  forgejo: the root with approval: pr-review and gate: always. A
#              push to main waits at wave 1. A pull request that adds a
#              resource to the root is approved on its head by a second user
#              with write access and merged: the merge's wave 1 applies with no
#              chant approve, and the bucket exists.
#              gitlab: the same root, with merge request approvals, which
#              name no commit. A merge request approved and then pushed to
#              again merges, and wave 1 still waits: the approval came before
#              the latest version. A second merge request, approved after its
#              latest push, merges, and wave 1 applies.
#   approve    gitlab: with the gate at always, a push to main waits at wave
#              1. terragucci approve, run in a clone, finds the waiting wave
#              and approves its digest; the next push applies the root.
#   gl-comment-plan  gitlab: comments: set, and a pipeline schedule with
#              TERRAGUCCI_SCHEDULE=comments. A Developer's /terragucci plan
#              note starts one merge request pipeline, which plans; a root
#              that is not one is refused, a Reporter's note gets no reply,
#              and a second play answers nothing again.
#   gl-comment-apply  gitlab: with the gate at always, a merged merge
#              request's wave 1 waits. /terragucci apply on an open merge
#              request is refused; on the merged one it retries wave 1 at the
#              merge commit, which waits again; after terragucci approve the
#              next note's retry applies it.
#   gl-comment-drift-schedule  gitlab: with drift and comments set, a
#              schedule with no TERRAGUCCI_SCHEDULE runs the drift job alone,
#              and the comments schedule the comments job alone.
#   pr-apply   gitlab: apply.when: pull-request with merge: auto. A merge
#              request approved by a second member after its last push gets
#              a Developer's /terragucci apply; the comments schedule's play
#              starts a pipeline on main, whose mr-apply job applies the head
#              (its bucket exists) and whose pr-merge job merges it.
#   pr-apply-stale  gitlab: main moves after the merge request was cut; its
#              /terragucci apply is refused as not up to date, no pipeline
#              starts on main, and nothing applies.
#   pr-apply-lock  gitlab: merge request A applies and stays open
#              (merge: manual); merge request B, which reaches the same root,
#              is refused by its mr-apply job naming the root and !A.
#   pr-apply-trust  gitlab: a pipeline started on main with TERRAGUCCI_HEAD
#              naming another commit than the merge request's head is refused
#              by mr-apply, which reads the head from GitLab, and nothing
#              applies.
#   gl-token-protected  gitlab: gitlab.token: protected, with GITLAB_TOKEN a
#              protected variable and main protected. A job the merge
#              request adds to its own pipeline finds GITLAB_TOKEN empty, the
#              plan job plans, and the comments schedule's play posts the
#              plan note and terragucci/plan on the head.
#   gl-check-token  gitlab: GITLAB_TOKEN an unprotected variable, as by
#              default. A branch's synth command, the branch's own code in the
#              check job, finds no forge token variable, and the check passes.
#   gl-managed-state  gitlab: a root on GitLab-managed state, its backend
#              password passed as TF_HTTP_PASSWORD from the job token. The push
#              to main applies it and GitLab holds its state.
#   gl-review-bot  gitlab: approval: pr-review and gate: always. A Developer's
#              merge request is approved after its last push by the user the
#              pipeline's token acts as, and merged: wave 1 still waits, says
#              that approval never counts, and nothing applies.
#
# init pins the images by the digest of the published release. `validation.sh
# run` (the CI gate) tests this commit, so push_dir and the github forge_run
# drop the digests and the runner takes the images bootstrap built from this
# tree under the same tag. `validation.sh record` sets TG_KEEP_DIGESTS=1: the
# record a release publishes runs the pinned, published images, which the
# runner (gitlab-runner, or act on the host) pulls the first time.
#
# BREAK=1 breaks the property each claim is about: a check claim puts its bad
# file in the clean push; an apply claim drops the apply job so the run stays
# green; reconcile runs a dry run, which opens nothing; gate-wait drops the
# `|| exit $?` after each job's heredoc, so the waiting job ends with 1;
# own-jobs writes terragucci's jobs over the repo's .gitlab-ci.yml, as init
# did before it kept the file, so the repo's job is gone.
# pr-review merges with no review (on gitlab, the second merge request is
# approved before its last push), so wave 1 waits and nothing applies;
# approve runs terragucci approve with --dry-run, which approves nothing.
# gl-comment-plan drops the comments job, so the play starts no pipeline;
# gl-comment-apply pushes to main after the merge, so the merge commit is
# superseded and no job at it is retried; gl-comment-drift-schedule drops the
# variable check from the drift rule, so the comments schedule runs drift too.
# pr-apply leaves the approval out, so the note is refused and nothing
# applies; pr-apply-stale leaves main where it was, so the head is up to date
# and applies; pr-apply-lock unlocks A before B asks, so B applies;
# pr-apply-trust names the merge request's own head, so it applies.
# gl-token-protected leaves GITLAB_TOKEN unprotected, so the merge request's
# job sees it; gl-review-bot has another Developer approve in place of the
# token's user, so wave 1 applies. gl-check-token drops the check job's
# unset line, so the synth command sees GITLAB_TOKEN and the check fails;
# gl-managed-state leaves TF_HTTP_PASSWORD out, so the backend has no
# credential (the scrub keeps CI_JOB_TOKEN from the binary) and the apply fails.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORGE="${1:?forge}"
CLAIM="${2:?claim}"
BREAK="${BREAK:-}"
TIMEOUT="${TERRAGUCCI_VALIDATE_TIMEOUT:-900}"
FIXTURE="$HERE/fixtures/s3-bucket"
# The bundle itself, not node_modules/.bin: npm ci links a workspace bin only
# when its target exists, and on a fresh clone dist/ is built after the
# install. `just validate` and `just validate-forge` build it first.
TERRAGUCCI="$HERE/../packages/terragucci/dist/terragucci.mjs"
BUCKET="terragucci-validate"

log()  { echo "[validate $FORGE $CLAIM] $*"; }
fail() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "SKIP: Docker is not available"; exit 0; }
case "$CLAIM" in check|apply|reconcile|tg-check|tg-apply|cdf-check|cdf-apply|gate-wait|own-jobs|pr-review|approve|gl-comment-plan|gl-comment-apply|gl-comment-drift-schedule|pr-apply|pr-apply-stale|pr-apply-lock|pr-apply-trust|gl-token-protected|gl-review-bot|gl-check-token|gl-managed-state) ;; *) echo "claim '$CLAIM' is not implemented for $FORGE (check, apply, reconcile, tg-check, tg-apply, cdf-check, cdf-apply, gate-wait, own-jobs, pr-review, pr-apply)" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:pr-apply*) ;; *:pr-apply*) echo "$CLAIM is gitlab's here; the smoke claims of that name run it on Forgejo" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:approve) ;; *:approve) echo "approve is implemented for gitlab here; the approve-command smoke claim runs it on Forgejo" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in forgejo:pr-review|gitlab:pr-review) ;; *:pr-review) echo "pr-review is implemented for forgejo and gitlab here" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:gate-wait) ;; *:gate-wait) echo "gate-wait is gitlab's: it checks how GitLab ends a waiting wave's job and status" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:gl-token-protected|gitlab:gl-review-bot|gitlab:gl-check-token|gitlab:gl-managed-state) ;; *:gl-token-protected|*:gl-review-bot|*:gl-check-token|*:gl-managed-state) echo "$CLAIM is gitlab's: it checks GitLab's variables, approvals and state" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:gl-comment-*) ;; *:gl-comment-*) echo "$CLAIM is gitlab's: it checks the comments schedule" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:own-jobs) ;; *:own-jobs) echo "own-jobs is gitlab's: it checks the include init adds to a repo's own .gitlab-ci.yml" >&2; exit 2 ;; esac

case "$FORGE:$CLAIM" in forgejo:check|forgejo:apply|forgejo:reconcile) echo "forgejo's $CLAIM is validate.sh's own; this script runs its tg-* and cdf-* claims" >&2; exit 2 ;; esac

# shellcheck source=forge-github.sh
. "$HERE/forge-$FORGE.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-validate.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
forge_load

ci_image() { (cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }'); }

# The pipeline files under DIR name terragucci's images by tag alone.
unpin_images() { # dir
  local f
  for f in "$1"/.forgejo/workflows/*.yml "$1"/.github/workflows/*.yml "$1"/.gitlab/*.yml "$1"/.gitlab-ci.yml; do
    if [ -f "$f" ]; then perl -pi -e 's#(ghcr\.io/intentius/terragucci-[a-z]+:[^@\s]+)\@sha256:[0-9a-f]{64}#$1#g' "$f"; fi
    # TG_TOFU_IMAGE names another tofu image for the jobs, such as the GitLab
    # lab's (stack/gitlab/gitlab.sh image).
    if [ -f "$f" ] && [ -n "${TG_TOFU_IMAGE:-}" ]; then TG_TOFU_IMAGE="$TG_TOFU_IMAGE" perl -pi -e 's#ghcr\.io/intentius/terragucci-tofu:[^@\s"'"'"']+#$ENV{TG_TOFU_IMAGE}#g' "$f"; fi
  done
}

# One commit of DIR, force-pushed. The message carries a timestamp, so every
# push has a new sha.
push_dir() { # dir remote branch message
  (
    cd "$1"
    [ -d .git ] || git init -q -b "$3"
    git checkout -q -B "$3"
    [ -n "${TG_KEEP_DIGESTS:-}" ] || unpin_images .
    git add -A
    git -c user.email=example@terragucci.local -c user.name=terragucci -c commit.gpgsign=false commit -q --allow-empty -m "$4"
    local out
    if ! out="$(git push -q --force "$2" "HEAD:refs/heads/$3" 2>&1)"; then
      echo "${out//${TOKEN}/***}" >&2; exit 1
    fi
    git rev-parse HEAD
  )
}

# The fixture with the pipeline init writes for this forge, found from the
# repo alone.
prepare() { # dir
  rm -rf "$1"; mkdir -p "$1"
  cp -R "$FIXTURE/infra" "$1/"
  (cd "$1" && git init -q -b main && "$TERRAGUCCI" init --forge "$FORGE" --binary tofu >/dev/null && rm -f terragucci.yml)
}

# The Terragrunt and choudoufu fixtures, with the pipeline and the
# terragucci.yml init writes for them, as a repo of either kind commits both.
prepare_tg() { # dir
  rm -rf "$1"; mkdir -p "$1"
  cp -R "$HERE/fixtures/terragrunt-buckets/." "$1/"
  (cd "$1" && git init -q -b main && "$TERRAGUCCI" init --forge "$FORGE" --binary tofu >/dev/null)
  grep -q 'terragucci-terragrunt:' "$1/$PIPELINE_FILE" || fail "the pipeline init wrote for the Terragrunt repo does not run in the terragrunt image"
}

prepare_cdf() { # dir
  rm -rf "$1"; mkdir -p "$1"
  cp -R "$HERE/fixtures/choudoufu-estate/." "$1/"
  (cd "$1" && git init -q -b main && "$TERRAGUCCI" init --forge "$FORGE" --binary choudoufu >/dev/null)
  grep -q 'terragucci-choudoufu:' "$1/$PIPELINE_FILE" || fail "the pipeline init wrote for the choudoufu estate does not run in the choudoufu image"
}

add_unformatted() {
  cat > "$1/infra/unformatted.tf" <<'TF'
locals {
    unformatted   = "tofu fmt rewrites this file"
  also = 1
}
TF
}

# A Terragrunt file that terragrunt hcl fmt would rewrite, in one unit.
add_unformatted_hcl() {
  cat > "$1/live/one/owner.hcl" <<'HCL'
locals {
    team   = "validate"
  owner = "terragucci"
}
HCL
}

# A formatted, valid resource that choudoufu live-check refuses: ignoring
# changes to tags would ignore the ownership markers too.
add_refused() {
  cat > "$1/infra/ignored.tf" <<'TF'
resource "aws_s3_bucket" "ignored" {
  bucket = "terragucci-validate-cdf-ignored"

  lifecycle {
    ignore_changes = [tags]
  }
}
TF
}

bucket_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' -I "$FLOCI/$1" || true; }
msg() { echo "validate $CLAIM $(date -u +%Y-%m-%dT%H:%M:%SZ) $$"; }

# A clean push to a branch must go green, and the same tree plus a bad file
# must go red with PATTERN in the job log.
run_check() { # repo prepare-fn bad-fn pattern what-it-names
  local repo="$1" prep="$2" bad="$3" pattern="$4" what="$5" sha
  forge_reset_repo "$repo"
  "$prep" "$WORK/clean"
  [ -n "$BREAK" ] && "$bad" "$WORK/clean"
  sha="$(forge_push "$WORK/clean" "$repo" validate/check "$(msg)")"
  log "pushed the clean tree to $repo validate/check at ${sha:0:8}"
  forge_run "$repo" validate/check "$sha"
  if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the clean tree's run ended '$RUN_STATUS'; expected success"; fi

  "$prep" "$WORK/dirty"
  "$bad" "$WORK/dirty"
  sha="$(forge_push "$WORK/dirty" "$repo" validate/check "$(msg)")"
  log "pushed $what to $repo validate/check at ${sha:0:8}"
  forge_run "$repo" validate/check "$sha"
  [ "$RUN_STATUS" = failure ] || fail "the run with $what ended '$RUN_STATUS'; expected failure"
  grep -Eq "$pattern" "$RUN_LOG" || { forge_logs; fail "the run failed, but its log does not name $what, so it failed somewhere other than the check"; }
  log "the run failed at the check and named $what"
}

# With BUCKETS deleted from floci, a push to main must go green and each
# bucket must then exist. BREAK drops the apply jobs from the pipeline.
run_apply() { # repo prepare-fn bucket...
  local repo="$1" prep="$2" b f sha code; shift 2
  forge_reset_repo "$repo"
  for b in "$@"; do
    curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true
    [ "$(bucket_code "$b")" = 404 ] || fail "could not clear $b from floci before the run"
  done
  log "$* absent from floci"
  "$prep" "$WORK/main"
  if [ -n "$BREAK" ]; then
    f="$WORK/main/$PIPELINE_FILE"
    sed -E '/^ {0,2}apply(-wave-[0-9]+)?:$/,$d' "$f" > "$f.new" && mv "$f.new" "$f"
    ! grep -qE '^ {0,2}apply(-wave-[0-9]+)?:$' "$f" || fail "could not drop the apply jobs from $PIPELINE_FILE"
  fi
  sha="$(forge_push "$WORK/main" "$repo" main "$(msg)")"
  log "pushed to $repo main at ${sha:0:8}"
  forge_run "$repo" main "$sha"
  if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the apply run ended '$RUN_STATUS'; expected success"; fi
  for b in "$@"; do
    code="$(bucket_code "$b")"
    if [ "$code" != 200 ]; then forge_logs; fail "the run went green but $b is not in floci (HEAD answered $code)"; fi
    log "$b exists in floci (HEAD $FLOCI/$b answered 200)"
  done
}

# With the gate at always, wave 1 waits. GITLAB_TOKEN lets the job post its
# statuses and push the pending record.
run_gate_wait() {
  local repo=validate-gate sha f st code
  forge_reset_repo "$repo"
  forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"
  curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
  prepare "$WORK/main"
  f="$WORK/main/$PIPELINE_FILE"
  sed 's/--gate on-destroy/--gate always/' "$f" > "$f.new" && mv "$f.new" "$f"
  grep -q -- '--gate always' "$f" || fail "could not set the gate to always in $PIPELINE_FILE"
  if [ -n "$BREAK" ]; then
    sed 's/ || exit \$?$//' "$f" > "$f.new" && mv "$f.new" "$f"
    ! grep -q '|| exit \$?$' "$f" || fail "could not drop the heredocs' exit from $PIPELINE_FILE"
  fi
  sha="$(forge_push "$WORK/main" "$repo" main "$(msg)")"
  log "pushed to $repo main at ${sha:0:8} with the gate at always"
  forge_run "$repo" main "$sha"
  grep -q "no finished pipeline" "$RUN_LOG" && { forge_logs; fail "the pipeline did not end: a running terragucci/apply status holds it open"; }
  [ "$RUN_STATUS" = failure ] || { forge_logs; fail "the pipeline ended '$RUN_STATUS'; a waiting wave fails it"; }
  grep -q "chant approve tf-apply wave-1" "$RUN_LOG" || { forge_logs; fail "wave 1 did not print its approval command"; }
  grep -q "answered 400" "$RUN_LOG" && { forge_logs; fail "GitLab refused a status call"; }
  grep -q "Job failed: exit code 3" "$RUN_LOG" || { forge_logs; fail "the waiting wave's job did not end with exit code 3"; }
  st="$(glapi "$URL/api/v4/projects/$(pid "$repo")/repository/commits/$sha/statuses?name=terragucci%2Fapply" | jq -c '.[0] // {}')"
  [ "$(jq -r .status <<<"$st")" = failed ] || fail "terragucci/apply is '$(jq -r .status <<<"$st")'; expected failed"
  jq -r .description <<<"$st" | grep -q "wave 1 waits" || fail "terragucci/apply does not say wave 1 waits: $(jq -r .description <<<"$st")"
  code="$(bucket_code "$BUCKET")"
  [ "$code" = 404 ] || fail "the waiting wave applied: $BUCKET answered $code"
  log "the pipeline ended failed, the wave's job ended with exit code 3, terragucci/apply is failed with the wave's command, and nothing applied"
}

# A repo that has its own .gitlab-ci.yml before init: one job naming no
# stage, which GitLab puts in test. It prints its stage, so the log shows it
# ran and where.
run_own_jobs() {
  local repo=validate-own dir="$WORK/own" sha
  forge_reset_repo "$repo"
  rm -rf "$dir"; mkdir -p "$dir"
  cp -R "$FIXTURE/infra" "$dir/"
  cat > "$dir/.gitlab-ci.yml" <<'YML'
# The repo's own pipeline, before terragucci.
unit-tests:
  script:
    - echo "own job ran in stage $CI_JOB_STAGE"
YML
  (cd "$dir" && git init -q -b main && "$TERRAGUCCI" init --binary tofu >/dev/null && rm -f terragucci.yml)
  [ -f "$dir/$PIPELINE_FILE" ] || fail "init wrote no $PIPELINE_FILE"
  grep -q 'local: .gitlab/terragucci.yml' "$dir/.gitlab-ci.yml" || fail "init added no include of $PIPELINE_FILE to the repo's .gitlab-ci.yml"
  grep -q '^unit-tests:' "$dir/.gitlab-ci.yml" || fail "init dropped the repo's own job from .gitlab-ci.yml"
  [ -n "$BREAK" ] && cp "$dir/$PIPELINE_FILE" "$dir/.gitlab-ci.yml"
  sha="$(forge_push "$dir" "$repo" validate/own "$(msg)")"
  log "pushed the repo with its own .gitlab-ci.yml to $repo validate/own at ${sha:0:8}"
  forge_run "$repo" validate/own "$sha"
  if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the pipeline ended '$RUN_STATUS'; expected success"; fi
  grep -q "own job ran in stage test" "$RUN_LOG" || { forge_logs; fail "the repo's own job did not run in the test stage"; }
  grep -q "^----- job 'check' -----" "$RUN_LOG" || { forge_logs; fail "terragucci's check job did not run"; }
  log "the repo's own job ran in the test stage, and terragucci's check ran beside it"
}

# approval: pr-review on Forgejo: the review of a pull request's head applies
# its gated wave once merged.
run_pr_review() {
  local repo=validate-review who="validate-reviewer" pass="validate-$RANDOM-$RANDOM-Aa1" rtoken sha head pr merge code
  forge_reset_repo "$repo"
  curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
  prepare "$WORK/main"
  printf 'approval: pr-review\ngate: always\n' > "$WORK/main/terragucci.yml"
  (cd "$WORK/main" && "$TERRAGUCCI" init --forge "$FORGE" --binary tofu >/dev/null) || fail "init failed with approval: pr-review"
  grep -q "pull_request_review" "$WORK/main/$PIPELINE_FILE" || fail "the pipeline has no pull_request_review trigger"
  sha="$(forge_push "$WORK/main" "$repo" main "$(msg)")"
  log "pushed to $repo main at ${sha:0:8}; wave 1 waits"
  forge_run "$repo" main "$sha"
  [ "$(bucket_code "$BUCKET")" = 404 ] || fail "wave 1 applied with no approval"
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$who?purge=true" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST -d "$(jq -cn --arg u "$who" --arg p "$pass" '{username: $u, email: ($u + "@terragucci.local"), password: $p, must_change_password: false}')" "$URL/api/v1/admin/users" || fail "could not make $who"
  api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"permission":"write"}' "$URL/api/v1/repos/$USER/$repo/collaborators/$who" || fail "could not give $who write access"
  rtoken="$(curl -fsS -u "$who:$pass" -H 'content-type: application/json' -X POST -d '{"name":"validate","scopes":["write:repository","write:issue"]}' "$URL/api/v1/users/$who/tokens" | jq -r '.sha1 // empty')"
  [ -n "$rtoken" ] || fail "no token for $who"
  printf 'resource "terraform_data" "reviewed" {\n  input = "reviewed"\n}\n' > "$WORK/main/infra/reviewed.tf"
  head="$(forge_push "$WORK/main" "$repo" change "$(msg)")"
  pr="$(api -H 'content-type: application/json' -X POST -d '{"head":"change","base":"main","title":"validate pr-review"}' "$URL/api/v1/repos/$USER/$repo/pulls" | jq -r '.number // empty')"
  [ -n "$pr" ] || fail "no pull request opened"
  wait_run "$USER/$repo" "$head" pull_request || fail "the pull request was not planned"
  if [ -z "$BREAK" ]; then
    curl -fsS -o /dev/null -H "Authorization: token $rtoken" -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg c "$head" '{event: "APPROVED", body: "read the plans", commit_id: $c}')" "$URL/api/v1/repos/$USER/$repo/pulls/$pr/reviews" || fail "$who could not approve"
    log "$who approved pull request $pr on ${head:0:8}"
  fi
  api -o /dev/null -H 'content-type: application/json' -X POST -d '{"Do":"merge"}' "$URL/api/v1/repos/$USER/$repo/pulls/$pr/merge" || fail "pull request $pr did not merge"
  merge="$(api "$URL/api/v1/repos/$USER/$repo/pulls/$pr" | jq -r '.merge_commit_sha // empty')"
  [ -n "$merge" ] || fail "pull request $pr has no merge commit"
  forge_run "$repo" main "$merge"
  code="$(bucket_code "$BUCKET")"
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$who?purge=true" 2>/dev/null || true
  if [ "$code" != 200 ]; then forge_logs; fail "the merge did not apply wave 1 on the review: $BUCKET answered $code"; fi
  grep -q "was approved on its head ${head:0:8} by $who" "$RUN_LOG" || { forge_logs; fail "wave 1 did not say the review approved it"; }
  log "the merge's wave 1 applied on $who's review of ${head:0:8}, and $BUCKET exists"
}

# A password GitLab takes: it refuses one made of common words and digits.
gl_password() { echo "Tg$(openssl rand -hex 16)!Zq"; }

# approval: pr-review on GitLab: an approval counts only after the merge
# request's latest version.
run_pr_review_gitlab() {
  local repo=validate-review who="validate-reviewer" pass="$(gl_password)" uid rtoken sha
  forge_reset_repo "$repo"
  forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"
  curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
  prepare "$WORK/main"
  printf 'approval: pr-review\ngate: always\n' > "$WORK/main/terragucci.yml"
  (cd "$WORK/main" && "$TERRAGUCCI" init --forge "$FORGE" --binary tofu >/dev/null) || fail "init failed with approval: pr-review"
  sha="$(forge_push "$WORK/main" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  [ "$(bucket_code "$BUCKET")" = 404 ] || fail "wave 1 applied with no approval"
  log "pushed to $repo main at ${sha:0:8}; wave 1 waits"
  uid="$(glapi "$URL/api/v4/users?username=$who" | jq -r '.[0].id // empty')"
  if [ -z "$uid" ]; then
    uid="$(glapi -X POST "$URL/api/v4/users" --data-urlencode "username=$who" --data-urlencode "name=$who" --data-urlencode "email=$who@terragucci.local" \
      --data-urlencode "password=$pass" --data-urlencode "skip_confirmation=true" | jq -r '.id // empty')"
  fi
  [ -n "$uid" ] || fail "could not make $who"
  glapi -o /dev/null -X POST "$URL/api/v4/projects/$(pid "$repo")/members" --data-urlencode "user_id=$uid" --data-urlencode "access_level=30" 2>/dev/null || true
  rtoken="$(glapi -X POST "$URL/api/v4/users/$uid/personal_access_tokens" --data-urlencode "name=validate-$RANDOM" --data-urlencode "scopes[]=api" | jq -r '.token // empty')"
  [ -n "$rtoken" ] || fail "no token for $who"

  # mr branch file approve-then-push -> merges a merge request that adds FILE, approved before its last push (1) or after it (0); prints nothing
  mr() {
    local branch="$1" file="$2" late="$3" head iid merge
    printf 'resource "terraform_data" "%s" {\n  input = "%s"\n}\n' "$branch" "$branch" > "$WORK/main/infra/$file"
    head="$(forge_push "$WORK/main" "$repo" "$branch" "$(msg)")"
    iid="$(glapi -X POST "$URL/api/v4/projects/$(pid "$repo")/merge_requests" --data-urlencode "source_branch=$branch" --data-urlencode "target_branch=main" --data-urlencode "title=validate $branch" | jq -r '.iid // empty')"
    [ -n "$iid" ] || fail "no merge request from $branch"
    forge_run "$repo" "$branch" "$head" merge_request_event
    if [ "$late" = 1 ]; then
      curl -fsS -o /dev/null -H "PRIVATE-TOKEN: $rtoken" -X POST "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/approve" || fail "$who could not approve !$iid"
      sleep 2
      echo "$branch after the approval" > "$WORK/main/infra/$branch.txt"
      head="$(forge_push "$WORK/main" "$repo" "$branch" "$(msg)")"
      forge_run "$repo" "$branch" "$head" merge_request_event
      log "!$iid approved by $who, then pushed to at ${head:0:8}"
    else
      sleep 2
      curl -fsS -o /dev/null -H "PRIVATE-TOKEN: $rtoken" -X POST "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/approve" || fail "$who could not approve !$iid"
      log "!$iid approved by $who after its last push, ${head:0:8}"
    fi
    forge_merge_pr "$repo" "$iid"
    merge="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid" | jq -r '.merge_commit_sha // .squash_commit_sha // empty')"
    [ -n "$merge" ] || fail "!$iid has no merge commit"
    forge_run "$repo" main "$merge"
  }

  mr early early.tf 1
  [ "$(bucket_code "$BUCKET")" = 404 ] || { forge_logs; fail "wave 1 applied on an approval given before the merge request's last push"; }
  grep -q "no member other than its author approved merge request" "$RUN_LOG" || { forge_logs; fail "wave 1 did not say the approval came before the latest push"; }
  log "an approval before the last push left wave 1 waiting"
  if [ -n "$BREAK" ]; then mr late late.tf 1; else mr late late.tf 0; fi
  [ "$(bucket_code "$BUCKET")" = 200 ] || { forge_logs; fail "wave 1 did not apply on an approval after the merge request's last push"; }
  grep -q "was approved on its head" "$RUN_LOG" || { forge_logs; fail "wave 1 did not say the approval approved it"; }
  log "an approval after the last push applied wave 1, and $BUCKET exists"
}

# terragucci approve on GitLab: the ledger is git, so the command works from
# any clone the person can push from.
run_approve() {
  local repo=validate-approve sha f out
  forge_reset_repo "$repo"
  forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"
  curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
  prepare "$WORK/main"
  f="$WORK/main/$PIPELINE_FILE"
  sed 's/--gate on-destroy/--gate always/' "$f" > "$f.new" && mv "$f.new" "$f"
  sha="$(forge_push "$WORK/main" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  grep -q "chant approve tf-apply wave-1" "$RUN_LOG" || { forge_logs; fail "wave 1 did not wait"; }
  [ "$(bucket_code "$BUCKET")" = 404 ] || fail "wave 1 applied with no approval"
  git clone -q "$(forge_remote "$repo")" "$WORK/approver" || fail "could not clone $repo"
  git -C "$WORK/approver" config user.name validate-approver
  git -C "$WORK/approver" config user.email validate-approver@terragucci.local
  out="$(cd "$WORK/approver" && PATH="$HERE/../node_modules/.bin:$PATH" "$TERRAGUCCI" approve --actor validate-approver ${BREAK:+--dry-run} 2>&1)" || { echo "$out"; fail "terragucci approve failed"; }
  log "terragucci approve: $(tail -1 <<<"$out")"
  sha="$(forge_push "$WORK/main" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  [ "$(bucket_code "$BUCKET")" = 200 ] || { forge_logs; fail "the push after terragucci approve did not apply wave 1"; }
  log "terragucci approve approved wave 1's digest, and the next push applied $BUCKET"
}

# ── GitLab comment commands: the comments schedule ────────────────────────────

# The fixture with comments: set (and the settings given), the pipeline init
# writes for it, the project's token, and no schedule left from a run before.
prepare_comments() { # repo terragucci.yml-lines...
  local repo="$1" sid; shift
  forge_reset_repo "$repo"
  forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"
  for sid in $(glapi "$URL/api/v4/projects/$(pid "$repo")/pipeline_schedules" | jq -r '.[].id'); do
    glapi -o /dev/null -X DELETE "$URL/api/v4/projects/$(pid "$repo")/pipeline_schedules/$sid" || true
  done
  # A directory of its own per repo, so nothing from another claim's tree is in it.
  CDIR="$WORK/comments-$repo"; mkdir -p "$CDIR"
  cp -R "$FIXTURE/infra" "$CDIR/"
  # The stack's GitLab is on localhost, which init does not take for GitLab, so the file names the forge.
  printf '%s\n' 'forge: gitlab' 'comments: "*/5 * * * *"' "$@" > "$CDIR/terragucci.yml"
  (cd "$CDIR" && git init -q -b main && "$TERRAGUCCI" init --forge gitlab --binary tofu >/dev/null) || fail "init failed with comments set"
  grep -q '^comments:$' "$CDIR/$PIPELINE_FILE" || fail "the pipeline init wrote has no comments job"
}

# A pipeline schedule on main, with TERRAGUCCI_SCHEDULE set to VALUE when one
# is given. Its cron is far off: the claim plays it.
gl_schedule() { # repo description [value] -> prints the schedule id
  local sid
  sid="$(glapi -X POST "$URL/api/v4/projects/$(pid "$1")/pipeline_schedules" --data-urlencode "description=$2" --data-urlencode "ref=main" \
    --data-urlencode "cron=0 0 1 1 *" --data-urlencode "active=true" | jq -r '.id // empty')"
  [ -n "$sid" ] || fail "could not make the $2 schedule"
  if [ -n "${3:-}" ]; then
    glapi -o /dev/null -X POST "$URL/api/v4/projects/$(pid "$1")/pipeline_schedules/$sid/variables" --data-urlencode "key=TERRAGUCCI_SCHEDULE" --data-urlencode "value=$3" \
      || fail "could not set TERRAGUCCI_SCHEDULE on the $2 schedule"
  fi
  echo "$sid"
}

# Play a schedule and wait for its pipeline to end. PLAY_PIPE is its id and
# PLAY_STATUS its status, both empty when the play started no pipeline (a
# pipeline with no job for it). GitLab plays a schedule once a minute at most.
gl_play() { # repo schedule-id [wait-for-end]
  local p="$URL/api/v4/projects/$(pid "$1")" before id="" i st deadline
  PLAY_PIPE=""; PLAY_STATUS=""
  before="$(glapi "$p/pipelines?source=schedule&order_by=id&sort=desc&per_page=1" | jq -r '.[0].id // 0')"
  for i in 1 2 3 4 5 6 7; do
    glapi -o /dev/null -X POST "$p/pipeline_schedules/$2/play" 2>/dev/null && break
    sleep 10
  done
  for i in $(seq 1 30); do
    id="$(glapi "$p/pipelines?source=schedule&order_by=id&sort=desc&per_page=1" | jq -r '.[0].id // 0')"
    [ "$id" -gt "$before" ] && break
    sleep 3
  done
  [ "$id" -gt "$before" ] || { log "playing schedule $2 started no pipeline"; return 0; }
  PLAY_PIPE="$id"
  [ "${3:-1}" = 1 ] || return 0
  deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    st="$(glapi "$p/pipelines/$id" | jq -r .status)"
    case "$st" in success|failed|canceled|skipped) break ;; esac
    [ "$(date +%s)" -lt "$deadline" ] || fail "pipeline $id did not end in ${TIMEOUT}s"
    sleep 5
  done
  PLAY_STATUS="$st"
  log "schedule $2 started pipeline $id: $st"
}

# The names of a pipeline's jobs, sorted, one line.
gl_jobs() { # repo pipeline
  glapi "$URL/api/v4/projects/$(pid "$1")/pipelines/$2/jobs?per_page=100" | jq -r '[.[].name] | sort | join(" ")'
}

# A user who is a member of REPO at LEVEL (30 Developer, 20 Reporter), with
# an api token of its own.
gl_member() { # repo name level -> prints the user's token
  local uid pass="$(gl_password)"
  uid="$(glapi "$URL/api/v4/users?username=$2" | jq -r '.[0].id // empty')"
  if [ -z "$uid" ]; then
    uid="$(glapi -X POST "$URL/api/v4/users" --data-urlencode "username=$2" --data-urlencode "name=$2" --data-urlencode "email=$2@terragucci.local" \
      --data-urlencode "password=$pass" --data-urlencode "skip_confirmation=true" | jq -r '.id // empty')"
  fi
  [ -n "$uid" ] || fail "could not make $2"
  glapi -o /dev/null -X POST "$URL/api/v4/projects/$(pid "$1")/members" --data-urlencode "user_id=$uid" --data-urlencode "access_level=$3" 2>/dev/null \
    || glapi -o /dev/null -X PUT "$URL/api/v4/projects/$(pid "$1")/members/$uid" --data-urlencode "access_level=$3" \
    || fail "could not make $2 a member at level $3"
  glapi -X POST "$URL/api/v4/users/$uid/personal_access_tokens" --data-urlencode "name=validate-$RANDOM" --data-urlencode "scopes[]=api" | jq -r '.token // empty'
}

# A note on merge request IID, written with TOKEN-OF-AUTHOR. Prints its id.
gl_note() { # repo iid token body
  curl -fsS -H "PRIVATE-TOKEN: $3" -X POST "$URL/api/v4/projects/$(pid "$1")/merge_requests/$2/notes" --data-urlencode "body=$4" | jq -r '.id // empty'
}

# The comments job's replies on merge request IID, one per line.
gl_replies() { # repo iid
  glapi "$URL/api/v4/projects/$(pid "$1")/merge_requests/$2/notes?per_page=100" | jq -r '.[] | select(.body | contains("terragucci:note=")) | .body | gsub("\n"; " ")'
}

# A merge request from BRANCH that adds a resource. Prints its iid once its
# pipeline ended.
gl_change_mr() { # repo branch
  local head iid
  printf 'resource "terraform_data" "%s" {\n  input = "%s"\n}\n' "${2//-/_}" "$2" > "$CDIR/infra/$2.tf"
  head="$(forge_push "$CDIR" "$1" "$2" "$(msg)")"
  iid="$(glapi -X POST "$URL/api/v4/projects/$(pid "$1")/merge_requests" --data-urlencode "source_branch=$2" --data-urlencode "target_branch=main" --data-urlencode "title=validate $2" | jq -r '.iid // empty')"
  [ -n "$iid" ] || fail "no merge request from $2"
  forge_run "$1" "$2" "$head" merge_request_event >&2
  echo "$iid"
}

# /terragucci plan on GitLab: a Developer's note starts a merge request
# pipeline, a root that is not one and a Reporter's note start nothing, and a
# second play answers nothing again.
run_comment_plan() {
  local repo=validate-comments sid sha iid dev rep n1 n2 n3 before after replies
  prepare_comments "$repo"
  if [ -n "$BREAK" ]; then
    sed '/^comments:$/,$d' "$CDIR/$PIPELINE_FILE" > "$CDIR/$PIPELINE_FILE.new" && mv "$CDIR/$PIPELINE_FILE.new" "$CDIR/$PIPELINE_FILE"
    ! grep -q '^comments:$' "$CDIR/$PIPELINE_FILE" || fail "could not drop the comments job"
  fi
  sha="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  sid="$(gl_schedule "$repo" "terragucci comments" comments)"
  dev="$(gl_member "$repo" validate-dev 30)"; rep="$(gl_member "$repo" validate-reporter 20)"
  [ -n "$dev" ] && [ -n "$rep" ] || fail "no tokens for the developer and the reporter"
  iid="$(gl_change_mr "$repo" comment-plan)"
  before="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/pipelines" | jq length)"
  n1="$(gl_note "$repo" "$iid" "$dev" "/terragucci plan")"
  n2="$(gl_note "$repo" "$iid" "$dev" "/terragucci plan envs/not-a-root")"
  n3="$(gl_note "$repo" "$iid" "$rep" "/terragucci plan")"
  [ -n "$n1" ] && [ -n "$n2" ] && [ -n "$n3" ] || fail "could not write the notes on !$iid"
  log "notes on !$iid: the developer's plan ($n1) and bad root ($n2), the reporter's plan ($n3)"
  gl_play "$repo" "$sid"
  [ -n "$PLAY_PIPE" ] || fail "playing the comments schedule started no pipeline"
  [ "$(gl_jobs "$repo" "$PLAY_PIPE")" = comments ] || fail "the comments schedule's pipeline ran $(gl_jobs "$repo" "$PLAY_PIPE"), not the comments job alone"
  [ "$PLAY_STATUS" = success ] || fail "the comments pipeline ended $PLAY_STATUS"
  after="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/pipelines" | jq length)"
  [ "$after" -eq $(( before + 1 )) ] || fail "!$iid has $after pipelines after the play, not $(( before + 1 ))"
  local mrp
  mrp="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/pipelines" | jq -r 'sort_by(.id) | last | .sha')"
  forge_run "$repo" comment-plan "$mrp" merge_request_event
  grep -q "^----- job 'plan' -----" "$RUN_LOG" || { forge_logs; fail "the new merge request pipeline ran no plan job"; }
  replies="$(gl_replies "$repo" "$iid")"
  grep -q "started pipeline .* to re-plan !$iid for validate-dev .*terragucci:note=$n1 -->" <<<"$replies" || { echo "$replies"; fail "no reply started a pipeline for the developer's plan"; }
  grep -q "envs/not-a-root is not a root of this repository.*terragucci:note=$n2 -->" <<<"$replies" || { echo "$replies"; fail "the bad root was not refused"; }
  ! grep -q "terragucci:note=$n3 -->" <<<"$replies" || fail "the reporter's note got a reply"
  log "the developer's plan started one merge request pipeline, the bad root was refused, the reporter got no reply"
  sleep 61
  gl_play "$repo" "$sid"
  [ "$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/pipelines" | jq length)" -eq "$after" ] || fail "the second play started another merge request pipeline"
  [ "$(gl_replies "$repo" "$iid" | wc -l)" -eq "$(wc -l <<<"$replies")" ] || fail "the second play replied again"
  log "the second play answered nothing again"
}

# /terragucci apply on GitLab: an open merge request is refused; on a merged
# one the merge commit's waiting wave is retried, waits again with no
# approval, and applies once terragucci approve approved it.
run_comment_apply() {
  local repo=validate-comments-apply sid sha iid open merge dev n job pipe
  prepare_comments "$repo" "gate: always"
  curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
  sha="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  sid="$(gl_schedule "$repo" "terragucci comments" comments)"
  dev="$(gl_member "$repo" validate-dev 30)"
  [ -n "$dev" ] || fail "no token for the developer"
  iid="$(gl_change_mr "$repo" comment-apply)"
  open="$(gl_change_mr "$repo" comment-open)"
  forge_merge_pr "$repo" "$iid"
  merge="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid" | jq -r '.merge_commit_sha // .squash_commit_sha // .sha')"
  forge_run "$repo" main "$merge"
  grep -q "chant approve tf-apply wave-1" "$RUN_LOG" || { forge_logs; fail "wave 1 of the merge commit did not wait"; }
  pipe="$(glapi "$URL/api/v4/projects/$(pid "$repo")/pipelines?sha=$merge&source=push" | jq -r '.[0].id')"
  log "!$iid merged at ${merge:0:8}; wave 1 waits in pipeline $pipe"
  if [ -n "$BREAK" ]; then
    # A later push to main: its apply supersedes the merge commit, so no job at the merge commit is retried.
    # It goes on top of main as GitLab has it, so the open merge request's branch stays unmerged.
    git -C "$CDIR" fetch -q "$(forge_remote "$repo")" main || fail "could not fetch main"
    git -C "$CDIR" checkout -q -f -B main FETCH_HEAD
    sha="$(forge_push "$CDIR" "$repo" main "$(msg)")"
    forge_run "$repo" main "$sha"
  fi
  gl_note "$repo" "$open" "$dev" "/terragucci apply" >/dev/null
  n="$(gl_note "$repo" "$iid" "$dev" "/terragucci apply")"
  gl_play "$repo" "$sid"
  [ "$PLAY_STATUS" = success ] || fail "the comments pipeline ended '${PLAY_STATUS:-none}'"
  gl_replies "$repo" "$open" | grep -q "!$open is not merged" || fail "the open merge request's apply was not refused"
  job="$(glapi "$URL/api/v4/projects/$(pid "$repo")/pipelines/$pipe/jobs?per_page=100" | jq -r '[.[] | select(.name == "apply-wave-1")] | sort_by(.id) | last | .id')"
  gl_replies "$repo" "$iid" | grep -q "retried apply-wave-1 of !$iid's merge commit ${merge:0:8}.*terragucci:note=$n -->" || { gl_replies "$repo" "$iid"; fail "the merged merge request's apply retried nothing at the merge commit"; }
  [ "$(glapi "$URL/api/v4/projects/$(pid "$repo")/jobs/$job" | jq -r .pipeline.sha)" = "$merge" ] || fail "the retried job did not run at the merge commit"
  wait_job "$repo" "$job"
  glapi "$URL/api/v4/projects/$(pid "$repo")/jobs/$job/trace" | grep -q "Job failed: exit code 3" || fail "the retried wave did not wait again (exit code 3) with no approval"
  [ "$(bucket_code "$BUCKET")" = 404 ] || fail "the retried wave applied with no approval"
  log "the retried wave 1 waited again with no approval"
  git clone -q "$(forge_remote "$repo")" "$WORK/approver" || fail "could not clone $repo"
  git -C "$WORK/approver" config user.name validate-approver
  git -C "$WORK/approver" config user.email validate-approver@terragucci.local
  (cd "$WORK/approver" && PATH="$HERE/../node_modules/.bin:$PATH" "$TERRAGUCCI" approve --actor validate-approver >/dev/null 2>&1) || fail "terragucci approve failed"
  n="$(gl_note "$repo" "$iid" "$dev" "/terragucci apply")"
  sleep 61
  gl_play "$repo" "$sid"
  job="$(glapi "$URL/api/v4/projects/$(pid "$repo")/pipelines/$pipe/jobs?per_page=100" | jq -r '[.[] | select(.name == "apply-wave-1")] | sort_by(.id) | last | .id')"
  wait_job "$repo" "$job"
  [ "$(glapi "$URL/api/v4/projects/$(pid "$repo")/jobs/$job" | jq -r .status)" = success ] || fail "the retried wave 1 did not apply after the approval"
  [ "$(bucket_code "$BUCKET")" = 200 ] || fail "$BUCKET is not in floci after the approved retry"
  log "after terragucci approve, the next note's retry applied wave 1 at ${merge:0:8}, and $BUCKET exists"
}

wait_job() { # repo job
  local deadline=$(( $(date +%s) + TIMEOUT ))
  until case "$(glapi "$URL/api/v4/projects/$(pid "$1")/jobs/$2" | jq -r .status)" in success|failed|canceled|skipped) true ;; *) false ;; esac; do
    [ "$(date +%s)" -lt "$deadline" ] || fail "job $2 did not finish in ${TIMEOUT}s"
    sleep 5
  done
}

# A drift schedule with no TERRAGUCCI_SCHEDULE runs the drift job alone, and
# the comments schedule the comments job alone.
run_comment_drift_schedule() {
  local repo=validate-comments-drift sha drift comments f
  prepare_comments "$repo" 'drift: "17 4 * * *"'
  f="$CDIR/$PIPELINE_FILE"
  if [ -n "$BREAK" ]; then
    sed 's/ && \$TERRAGUCCI_SCHEDULE != "comments"//' "$f" > "$f.new" && mv "$f.new" "$f"
    ! grep -q 'TERRAGUCCI_SCHEDULE != "comments"' "$f" || fail "could not drop the variable check from the drift rule"
  fi
  sha="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  drift="$(gl_schedule "$repo" "terragucci drift")"
  comments="$(gl_schedule "$repo" "terragucci comments" comments)"
  gl_play "$repo" "$drift" 0
  [ -n "$PLAY_PIPE" ] || fail "the drift schedule started no pipeline"
  [ "$(gl_jobs "$repo" "$PLAY_PIPE")" = drift ] || fail "the drift schedule's pipeline ran '$(gl_jobs "$repo" "$PLAY_PIPE")', not the drift job alone"
  log "the drift schedule, with no TERRAGUCCI_SCHEDULE, ran the drift job alone"
  gl_play "$repo" "$comments" 0
  [ -n "$PLAY_PIPE" ] || fail "the comments schedule started no pipeline"
  [ "$(gl_jobs "$repo" "$PLAY_PIPE")" = comments ] || fail "the comments schedule's pipeline ran '$(gl_jobs "$repo" "$PLAY_PIPE")', not the comments job alone"
  log "the comments schedule ran the comments job alone"
}

# ── GitLab apply before merge: the comments job and the mr-apply pipeline ─────

# The comments fixture with apply.when: pull-request, and the merge token as a
# variable scoped to the terragucci-merge environment, which only the
# comments and pr-merge jobs name. The stack leaves main unprotected, so the
# variable is not protected either.
prepare_pr_apply() { # repo merge
  prepare_comments "$1" "apply:" "  when: pull-request" "  merge: $2" "  merge_token_env: TERRAGUCCI_MERGE_TOKEN"
  grep -q '^mr-apply:$' "$CDIR/$PIPELINE_FILE" || fail "the pipeline init wrote has no mr-apply job"
  local p="$URL/api/v4/projects/$(pid "$1")"
  curl -s -o /dev/null -H "PRIVATE-TOKEN: $TOKEN" -X DELETE "$p/variables/TERRAGUCCI_MERGE_TOKEN?filter%5Benvironment_scope%5D=terragucci-merge" || true
  glapi -o /dev/null -X POST "$p/variables" --data-urlencode "key=TERRAGUCCI_MERGE_TOKEN" --data-urlencode "value=$TOKEN" \
    --data-urlencode "environment_scope=terragucci-merge" --data-urlencode "protected=false" || fail "could not set TERRAGUCCI_MERGE_TOKEN"
}

# A merge request from BRANCH that renames the root's bucket to BUCKET, cut
# from main as CDIR has it. Prints its iid once its pipeline ended.
gl_bucket_mr() { # repo branch bucket
  local f="$CDIR/infra/main.tf" head iid
  git -C "$CDIR" checkout -q -f main
  sed "s/default = \"terragucci-validate\"/default = \"$3\"/" "$f" > "$f.new" && mv "$f.new" "$f"
  grep -q "\"$3\"" "$f" || fail "could not rename the bucket to $3"
  head="$(forge_push "$CDIR" "$1" "$2" "$(msg)")"
  iid="$(glapi -X POST "$URL/api/v4/projects/$(pid "$1")/merge_requests" --data-urlencode "source_branch=$2" --data-urlencode "target_branch=main" --data-urlencode "title=validate $2" | jq -r '.iid // empty')"
  [ -n "$iid" ] || fail "no merge request from $2"
  forge_run "$1" "$2" "$head" merge_request_event >&2
  git -C "$CDIR" checkout -q -f main
  echo "$iid"
}

# An approval of merge request IID by the member whose token is given, after its last push.
gl_approve() { # repo iid token
  sleep 2
  curl -fsS -o /dev/null -H "PRIVATE-TOKEN: $3" -X POST "$URL/api/v4/projects/$(pid "$1")/merge_requests/$2/approve" || fail "could not approve !$2"
}

# Every terragucci note on merge request IID, one per line.
gl_said() { # repo iid
  glapi "$URL/api/v4/projects/$(pid "$1")/merge_requests/$2/notes?per_page=100" | jq -r '.[] | select(.body | startswith("terragucci:")) | .body | gsub("\n"; " ")'
}

gl_api_pipelines() { glapi "$URL/api/v4/projects/$(pid "$1")/pipelines?source=api&per_page=100" | jq length; }

run_pr_apply_gitlab() {
  local repo=validate-pr-apply bucket=terragucci-validate-pr-apply main sid dev rtok iid n head
  prepare_pr_apply "$repo" auto
  curl -s -o /dev/null -X DELETE "$FLOCI/$bucket" || true
  main="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$main"
  sid="$(gl_schedule "$repo" "terragucci comments" comments)"
  dev="$(gl_member "$repo" validate-dev 30)"; rtok="$(gl_member "$repo" validate-rev 30)"
  [ -n "$dev" ] && [ -n "$rtok" ] || fail "no tokens for the developer and the reviewer"
  iid="$(gl_bucket_mr "$repo" pr-apply "$bucket")"
  head="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid" | jq -r .sha)"
  [ -n "$BREAK" ] || gl_approve "$repo" "$iid" "$rtok"
  n="$(gl_note "$repo" "$iid" "$dev" "/terragucci apply")"
  gl_play "$repo" "$sid"
  [ "$PLAY_STATUS" = success ] || fail "the comments pipeline ended '${PLAY_STATUS:-none}'"
  gl_replies "$repo" "$iid" | grep -q "started pipeline .* on main to apply !$iid's head ${head:0:8} for validate-dev.*terragucci:note=$n -->" || { gl_said "$repo" "$iid"; fail "the note started no pipeline on main"; }
  forge_run "$repo" main "$main" api
  if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the mr-apply pipeline ended '$RUN_STATUS'"; fi
  grep -q "^----- job 'mr-apply' -----" "$RUN_LOG" && grep -q "^----- job 'pr-merge' -----" "$RUN_LOG" || { forge_logs; fail "the pipeline did not run mr-apply and pr-merge"; }
  [ "$(bucket_code "$bucket")" = 200 ] || { forge_logs; fail "$bucket is not in floci after mr-apply"; }
  [ "$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid" | jq -r .state)" = merged ] || { gl_said "$repo" "$iid"; fail "!$iid was not merged after its waves applied"; }
  gl_said "$repo" "$iid" | grep -q "merged !$iid at ${head:0:8}" || { gl_said "$repo" "$iid"; fail "no reply said !$iid was merged"; }
  log "!$iid applied its head ${head:0:8} from a pipeline on main ($bucket exists) and pr-merge merged it"
}

run_pr_apply_stale_gitlab() {
  local repo=validate-pr-apply-stale bucket=terragucci-validate-pr-stale main sid dev rtok iid before
  prepare_pr_apply "$repo" manual
  curl -s -o /dev/null -X DELETE "$FLOCI/$bucket" || true
  main="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$main"
  sid="$(gl_schedule "$repo" "terragucci comments" comments)"
  dev="$(gl_member "$repo" validate-dev 30)"; rtok="$(gl_member "$repo" validate-rev 30)"
  [ -n "$dev" ] && [ -n "$rtok" ] || fail "no tokens for the developer and the reviewer"
  iid="$(gl_bucket_mr "$repo" pr-stale "$bucket")"
  if [ -z "$BREAK" ]; then
    echo "# main moved after the merge request was cut" > "$CDIR/MOVED.md"
    main="$(forge_push "$CDIR" "$repo" main "$(msg)")"
    forge_run "$repo" main "$main"
    log "main moved to ${main:0:8} after !$iid was cut"
  fi
  # The approval comes after main moved, so only the head being behind holds the apply back.
  gl_approve "$repo" "$iid" "$rtok"
  before="$(gl_api_pipelines "$repo")"
  gl_note "$repo" "$iid" "$dev" "/terragucci apply" >/dev/null
  gl_play "$repo" "$sid"
  gl_replies "$repo" "$iid" | grep -q "!$iid is not up to date with main" || { gl_said "$repo" "$iid"; fail "the apply of a merge request behind main was not refused as not up to date"; }
  [ "$(gl_api_pipelines "$repo")" -eq "$before" ] || fail "a pipeline started on main for the stale merge request"
  [ "$(bucket_code "$bucket")" = 404 ] || fail "$bucket exists: the stale merge request applied"
  log "the apply of !$iid, behind main, was refused as not up to date, and nothing applied"
}

run_pr_apply_lock_gitlab() {
  local repo=validate-pr-apply-lock main sid dev rtok a b
  prepare_pr_apply "$repo" manual
  for b in terragucci-validate-lock-a terragucci-validate-lock-b; do curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true; done
  main="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$main"
  sid="$(gl_schedule "$repo" "terragucci comments" comments)"
  dev="$(gl_member "$repo" validate-dev 30)"; rtok="$(gl_member "$repo" validate-rev 30)"
  [ -n "$dev" ] && [ -n "$rtok" ] || fail "no tokens for the developer and the reviewer"
  a="$(gl_bucket_mr "$repo" lock-a terragucci-validate-lock-a)"; gl_approve "$repo" "$a" "$rtok"
  b="$(gl_bucket_mr "$repo" lock-b terragucci-validate-lock-b)"; gl_approve "$repo" "$b" "$rtok"
  gl_note "$repo" "$a" "$dev" "/terragucci apply" >/dev/null
  gl_play "$repo" "$sid"
  forge_run "$repo" main "$main" api
  [ "$(bucket_code terragucci-validate-lock-a)" = 200 ] || { forge_logs; fail "!$a did not apply"; }
  log "!$a applied and stays open, holding infra"
  if [ -n "$BREAK" ]; then
    gl_note "$repo" "$a" "$dev" "/terragucci unlock" >/dev/null
    sleep 61; gl_play "$repo" "$sid"
    forge_run "$repo" main "$main" api
  fi
  gl_note "$repo" "$b" "$dev" "/terragucci apply" >/dev/null
  sleep 61; gl_play "$repo" "$sid"
  gl_replies "$repo" "$b" | grep -q "started pipeline .* on main to apply !$b" || { gl_said "$repo" "$b"; fail "the note on !$b started no pipeline"; }
  forge_run "$repo" main "$main" api
  gl_said "$repo" "$b" | grep -q '`infra` is locked by merge request !'"$a"' (applied by validate-dev), so !'"$b"' is not applied' || { gl_said "$repo" "$b"; fail "!$b was not refused naming the root and !$a"; }
  [ "$(bucket_code terragucci-validate-lock-b)" = 404 ] || fail "!$b applied a root !$a holds"
  log "!$b was refused: infra is locked by !$a, and nothing of !$b applied"
}

run_pr_apply_trust_gitlab() {
  local repo=validate-pr-apply-trust bucket=terragucci-validate-pr-trust main dev rtok iid n head named
  prepare_pr_apply "$repo" manual
  curl -s -o /dev/null -X DELETE "$FLOCI/$bucket" || true
  main="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$main"
  dev="$(gl_member "$repo" validate-dev 30)"; rtok="$(gl_member "$repo" validate-rev 30)"
  [ -n "$dev" ] && [ -n "$rtok" ] || fail "no tokens for the developer and the reviewer"
  iid="$(gl_bucket_mr "$repo" pr-trust "$bucket")"
  head="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid" | jq -r .sha)"
  gl_approve "$repo" "$iid" "$rtok"
  n="$(gl_note "$repo" "$iid" "$dev" "/terragucci apply")"
  # Started by hand, as anyone who may run a pipeline on main can, naming main's commit as the head.
  named="$main"; [ -n "$BREAK" ] && named="$head"
  glapi -o /dev/null -H 'content-type: application/json' -X POST "$URL/api/v4/projects/$(pid "$repo")/pipeline" \
    -d "$(jq -cn --arg mr "$iid" --arg n "$n" --arg h "$named" '{ref: "main", variables: [{key: "TERRAGUCCI_MR", value: $mr}, {key: "TERRAGUCCI_NOTE", value: $n}, {key: "TERRAGUCCI_HEAD", value: $h}]}')" \
    || fail "could not start a pipeline on main"
  forge_run "$repo" main "$main" api
  gl_said "$repo" "$iid" | grep -q "this pipeline was started for the head ${named:0:8}, and !$iid's head is ${head:0:8}, so nothing is applied" || { forge_logs; gl_said "$repo" "$iid"; fail "mr-apply did not refuse a head the merge request does not have"; }
  [ "$(bucket_code "$bucket")" = 404 ] || fail "$bucket exists: a pipeline naming another head applied"
  log "mr-apply refused TERRAGUCCI_HEAD=${named:0:8}, which is not !$iid's head ${head:0:8}, and nothing applied"
}

# ── GitLab's token: gitlab.token: protected, and the token's own approval ─────

# A CI/CD variable on the project that only pipelines on protected branches see.
gl_protected_var() { # repo key value
  glapi -o /dev/null -X PUT "$URL/api/v4/projects/$(pid "$1")/variables/$2" --data-urlencode "value=$3" --data-urlencode "protected=true" 2>/dev/null \
    || glapi -o /dev/null -X POST "$URL/api/v4/projects/$(pid "$1")/variables" --data-urlencode "key=$2" --data-urlencode "value=$3" --data-urlencode "protected=true" \
    || fail "could not make $2 a protected variable"
}

# main protected, with force pushes allowed so the claim can still push it.
gl_protect_main() { # repo
  curl -s -o /dev/null -H "PRIVATE-TOKEN: $TOKEN" -X DELETE "$URL/api/v4/projects/$(pid "$1")/protected_branches/main"
  glapi -o /dev/null -X POST "$URL/api/v4/projects/$(pid "$1")/protected_branches" --data-urlencode "name=main" \
    --data-urlencode "push_access_level=40" --data-urlencode "merge_access_level=40" --data-urlencode "allow_force_push=true" \
    || fail "could not protect main"
}

# gitlab.token: protected: a merge request's pipeline never sees the token,
# and the comments schedule posts its plan note.
run_token_protected() {
  local repo=validate-token-protected sid head iid img f notes st
  prepare_comments "$repo" "gitlab:" "  token: protected"
  f="$CDIR/$PIPELINE_FILE"
  grep -q -- '--plan-notes' "$f" || fail "the comments job does not post the plan notes"
  if [ -n "$BREAK" ]; then forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"; else gl_protected_var "$repo" GITLAB_TOKEN "$TOKEN"; fi
  gl_protect_main "$repo"
  head="$(forge_push "$CDIR" "$repo" main "$(msg)")"
  forge_run "$repo" main "$head"
  sid="$(gl_schedule "$repo" "terragucci comments" comments)"
  # The merge request adds a job to its own pipeline, as its author can: it says whether the token reached it.
  img="$(awk '/^plan:$/ { p = 1 } p && /^    name: / { print $2; exit }' "$f")"
  [ -n "$img" ] || fail "could not read the plan job's image"
  cat >> "$f" <<YML

token-probe:
  stage: plan
  image:
    name: $img
  rules:
    - if: \$CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - 'if [ -z "\${GITLAB_TOKEN:-}" ]; then echo "token-probe: GITLAB_TOKEN is empty"; else echo "token-probe: GITLAB_TOKEN is set"; fi'
YML
  iid="$(gl_change_mr "$repo" token-protected)"
  head="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid" | jq -r .sha)"
  forge_run "$repo" token-protected "$head" merge_request_event
  grep -q "token-probe: GITLAB_TOKEN is empty" "$RUN_LOG" || { forge_logs; fail "the merge request's own job saw GITLAB_TOKEN"; }
  grep -q "^----- job 'plan' -----" "$RUN_LOG" || { forge_logs; fail "the merge request pipeline ran no plan job"; }
  log "the merge request's own job found GITLAB_TOKEN empty"
  gl_play "$repo" "$sid"
  [ "$PLAY_STATUS" = success ] || fail "the comments pipeline ended '${PLAY_STATUS:-none}'"
  notes="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/notes?per_page=100" | jq -r '.[] | .body | gsub("\n"; " ")')"
  grep -q "^<!-- terragucci:plan roots=infra -->.*<!-- terragucci:plan-job=[0-9]* -->" <<<"$notes" || { echo "$notes"; fail "the comments play posted no plan note on !$iid"; }
  st="$(glapi "$URL/api/v4/projects/$(pid "$repo")/repository/commits/$head/statuses?name=terragucci%2Fplan" | jq -r '.[0].status // empty')"
  [ "$st" = success ] || fail "terragucci/plan on ${head:0:8} is '${st:-absent}'; expected success"
  log "the comments play posted !$iid's plan note and terragucci/plan success on ${head:0:8}"
}

# The check job runs a branch's code with no forge token variable, though
# GitLab hands it GITLAB_TOKEN, an unprotected variable by default.
run_check_token() {
  local repo=validate-check-token dir="$WORK/check-token" f sha
  forge_reset_repo "$repo"
  forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"
  mkdir -p "$dir"
  cp -R "$FIXTURE/infra" "$dir/"
  # synth runs in the check job's shell, where the branch's code runs; it says only whether a token reached it.
  # shellcheck disable=SC2016 # expanded in the job
  printf '%s\n' 'forge: gitlab' 'synth: '"'"'[ "$CI_JOB_NAME" != check ] || [ -z "${GITLAB_TOKEN:-}${TG_TOKEN:-}${CI_JOB_TOKEN:-}" ] || { echo "token-probe: the check job runs this with a forge token"; exit 1; }'"'" > "$dir/terragucci.yml"
  (cd "$dir" && git init -q -b main && "$TERRAGUCCI" init --forge gitlab --binary tofu >/dev/null) || fail "init failed with the synth probe"
  f="$dir/$PIPELINE_FILE"
  grep -q 'unset TG_TOKEN TG_MERGE_TOKEN GITLAB_TOKEN CI_JOB_TOKEN' "$f" || fail "the check job does not drop the forge token variables"
  if [ -n "$BREAK" ]; then
    grep -v 'unset TG_TOKEN TG_MERGE_TOKEN GITLAB_TOKEN CI_JOB_TOKEN' "$f" > "$f.new" && mv "$f.new" "$f"
  fi
  sha="$(forge_push "$dir" "$repo" validate/check-token "$(msg)")"
  forge_run "$repo" validate/check-token "$sha"
  if grep -q "token-probe: the check job runs this with a forge token" "$RUN_LOG"; then forge_logs; fail "the check job's synth command found a forge token"; fi
  [ "$RUN_STATUS" = success ] || { forge_logs; fail "the branch's run ended '$RUN_STATUS'"; }
  log "the check job ran the branch's synth command with no forge token variable"
}

# GitLab-managed state with the scrub: the backend's password reaches the
# binary as TF_HTTP_PASSWORD, which passes as set, never as CI_JOB_TOKEN.
run_managed_state() {
  local repo=validate-managed-state dir="$WORK/managed-state" sha state
  forge_reset_repo "$repo"
  forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"
  mkdir -p "$dir/infra"
  printf 'terraform {\n  backend "http" {}\n}\n\nresource "terraform_data" "state" {\n  input = "gitlab-managed"\n}\n' > "$dir/infra/main.tf"
  {
    echo 'forge: gitlab'
    echo 'gate: never'
    echo 'env:'
    # shellcheck disable=SC2016 # GitLab expands these in the job
    echo '  TF_HTTP_ADDRESS: "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/terraform/state/infra"'
    # shellcheck disable=SC2016
    echo '  TF_HTTP_LOCK_ADDRESS: "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/terraform/state/infra/lock"'
    # shellcheck disable=SC2016
    echo '  TF_HTTP_UNLOCK_ADDRESS: "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/terraform/state/infra/lock"'
    echo '  TF_HTTP_LOCK_METHOD: POST'
    echo '  TF_HTTP_UNLOCK_METHOD: DELETE'
    if [ -z "$BREAK" ]; then
      echo '  TF_HTTP_USERNAME: gitlab-ci-token'
      # shellcheck disable=SC2016
      echo '  TF_HTTP_PASSWORD: "${CI_JOB_TOKEN}"'
    fi
  } > "$dir/terragucci.yml"
  (cd "$dir" && git init -q -b main && "$TERRAGUCCI" init --forge gitlab --binary tofu >/dev/null) || fail "init failed with GitLab-managed state"
  sha="$(forge_push "$dir" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  [ "$RUN_STATUS" = success ] || { forge_logs; fail "the push to main on GitLab-managed state ended '$RUN_STATUS'"; }
  state="$(glapi "$URL/api/v4/projects/$(pid "$repo")/terraform/state/infra" 2>/dev/null || true)"
  grep -q 'gitlab-managed' <<<"$state" || fail "GitLab holds no state for infra with the applied resource"
  log "the apply on GitLab-managed state wrote its state through TF_HTTP_PASSWORD"
}

# approval: pr-review: an approval by the user the pipeline's token acts as
# never releases a wave.
run_review_bot() {
  local repo=validate-review-bot sha dev rtok head iid merge approver
  forge_reset_repo "$repo"
  forge_ci_var "$repo" GITLAB_TOKEN "$TOKEN"
  curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
  prepare "$WORK/main"
  printf 'approval: pr-review\ngate: always\n' > "$WORK/main/terragucci.yml"
  (cd "$WORK/main" && "$TERRAGUCCI" init --forge "$FORGE" --binary tofu >/dev/null) || fail "init failed with approval: pr-review"
  sha="$(forge_push "$WORK/main" "$repo" main "$(msg)")"
  forge_run "$repo" main "$sha"
  [ "$(bucket_code "$BUCKET")" = 404 ] || fail "wave 1 applied with no approval"
  dev="$(gl_member "$repo" validate-dev 30)"; rtok="$(gl_member "$repo" validate-rev 30)"
  [ -n "$dev" ] && [ -n "$rtok" ] || fail "no tokens for the developer and the reviewer"
  printf 'resource "terraform_data" "bot" {\n  input = "bot"\n}\n' > "$WORK/main/infra/bot.tf"
  head="$(forge_push "$WORK/main" "$repo" review-bot "$(msg)")"
  # The developer opens it, so the token's user is not its author.
  iid="$(curl -fsS -H "PRIVATE-TOKEN: $dev" -X POST "$URL/api/v4/projects/$(pid "$repo")/merge_requests" --data-urlencode "source_branch=review-bot" --data-urlencode "target_branch=main" --data-urlencode "title=validate review-bot" | jq -r '.iid // empty')"
  [ -n "$iid" ] || fail "no merge request from review-bot"
  forge_run "$repo" review-bot "$head" merge_request_event
  sleep 2
  approver="$TOKEN"; [ -n "$BREAK" ] && approver="$rtok"
  curl -fsS -o /dev/null -H "PRIVATE-TOKEN: $approver" -X POST "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid/approve" || fail "could not approve !$iid"
  log "!$iid approved after its last push, ${head:0:8}, by $(curl -fsS -H "PRIVATE-TOKEN: $approver" "$URL/api/v4/user" | jq -r .username)"
  forge_merge_pr "$repo" "$iid"
  merge="$(glapi "$URL/api/v4/projects/$(pid "$repo")/merge_requests/$iid" | jq -r '.merge_commit_sha // .squash_commit_sha // empty')"
  [ -n "$merge" ] || fail "!$iid has no merge commit"
  forge_run "$repo" main "$merge"
  [ "$(bucket_code "$BUCKET")" = 404 ] || { forge_logs; fail "wave 1 applied on the approval of the token's own user"; }
  grep -q "the user the job's token acts as, never counts" "$RUN_LOG" || { forge_logs; fail "wave 1 did not say the token user's approval never counts"; }
  log "the approval by the token's own user left wave 1 waiting, and $BUCKET does not exist"
}

started=$(date +%s)
[ -n "$BREAK" ] && log "BREAK=1: breaking the property on purpose; this run must fail"

case "$CLAIM" in
  check) run_check validate prepare add_unformatted 'unformatted\.tf' "infra/unformatted.tf" ;;
  apply) run_apply validate prepare "$BUCKET" ;;
  tg-check) run_check validate-tg prepare_tg add_unformatted_hcl 'owner\.hcl' "live/one/owner.hcl" ;;
  tg-apply) run_apply validate-tg prepare_tg terragucci-validate-tg-one terragucci-validate-tg-two ;;
  cdf-check) run_check validate-cdf prepare_cdf add_refused 'refused: infra: .*(aws_s3_bucket\.ignored|ignored\.tf)' "the refused aws_s3_bucket.ignored" ;;
  cdf-apply)
    run_apply validate-cdf prepare_cdf terragucci-validate-cdf
    # The bucket choudoufu created carries the estate's marker, so the apply
    # ran with live markers on rather than as stock OpenTofu.
    tags="$(curl -s -m 5 "$FLOCI/terragucci-validate-cdf?tagging" || true)"
    grep -q 'tofu-estate' <<<"$tags" || { echo "$tags"; fail "terragucci-validate-cdf carries no tofu-estate tag, so choudoufu did not apply it as an estate"; }
    log "terragucci-validate-cdf carries the tofu-estate marker"
    ;;
  gate-wait) run_gate_wait ;;
  own-jobs) run_own_jobs ;;
  pr-review) if [ "$FORGE" = gitlab ]; then run_pr_review_gitlab; else run_pr_review; fi ;;
  approve) run_approve ;;
  gl-comment-plan) run_comment_plan ;;
  gl-comment-apply) run_comment_apply ;;
  gl-comment-drift-schedule) run_comment_drift_schedule ;;
  pr-apply) run_pr_apply_gitlab ;;
  pr-apply-stale) run_pr_apply_stale_gitlab ;;
  pr-apply-lock) run_pr_apply_lock_gitlab ;;
  pr-apply-trust) run_pr_apply_trust_gitlab ;;
  gl-token-protected) run_token_protected ;;
  gl-review-bot) run_review_bot ;;
  gl-check-token) run_check_token ;;
  gl-managed-state) run_managed_state ;;
  reconcile)
    p="tg-reconcile-$FORGE"
    for name in two-roots in-line; do forge_reset_repo "$name"; done
    curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
    for b in "$p-network" "$p-network-app" "$p-inline" "$p-inline-app"; do curl -s -o /dev/null -X DELETE "$FLOCI/$b" || true; done
    head='terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "KEY"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

provider "aws" {
  region            = "us-east-1"
  s3_use_path_style = true
}
'
    mk() { # dir state-prefix bucket-prefix
      mkdir -p "$1/network" "$1/app"
      { echo "${head/KEY/$2/network.tfstate}"
        printf 'resource "aws_s3_bucket" "this" {\n  bucket = "%s"\n}\n\noutput "bucket" {\n  value = aws_s3_bucket.this.bucket\n}\n' "$3"
      } > "$1/network/main.tf"
      { echo "${head/KEY/$2/app.tfstate}"
        printf 'data "terraform_remote_state" "network" {\n  backend = "s3"\n  config = {\n    bucket         = "shop-terraform-state"\n    key            = "%s/network.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\nresource "aws_s3_bucket" "this" {\n  bucket = "${data.terraform_remote_state.network.outputs.bucket}-app"\n}\n' "$2"
      } > "$1/app/main.tf"
    }
    mk "$WORK/two-roots" "reconcile-$FORGE" "$p-network"
    mk "$WORK/in-line" "inline-$FORGE" "$p-inline"
    # in-line's pipeline is rendered with the same settings the control repo
    # hands every project (they change the pipeline: token_env adds the plan
    # job's token), so the claim cannot drift from the renderer. Its
    # terragucci.yml stays: the jobs read token_env there, and reconcile
    # leaves a project's own file alone when it holds the control repo's value.
    DEFAULTS="forge: $FORGE
binary: tofu
token_env: $FORGE_TOKEN_ENV"
    (cd "$WORK/in-line" && git init -q -b main && echo "$DEFAULTS" > terragucci.yml && "$TERRAGUCCI" init >/dev/null)
    # Pushed as init writes it, digests and all, so reconcile finds it in line;
    # the github forge_run drops the digests from the clone it runs.
    TG_KEEP_DIGESTS=1 forge_push "$WORK/in-line" in-line main "Two roots, pipeline in line" >/dev/null
    forge_push "$WORK/two-roots" two-roots main "Two roots, no pipeline" >/dev/null

    cat > "$WORK/terragucci.yml" <<YML
defaults:
$(sed 's/^/  /' <<<"$DEFAULTS")
projects:
  $(forge_project_key in-line):
    url: $(forge_config_url in-line)
  $(forge_project_key two-roots):
    url: $(forge_config_url two-roots)
YML
    mode=apply
    [ -n "$BREAK" ] && mode=dry-run
    out="$(env "$FORGE_TOKEN_ENV=$TOKEN" "$TERRAGUCCI" reconcile --config "$WORK/terragucci.yml" --mode "$mode" 2>&1)" || { echo "$out"; fail "reconcile exited non-zero"; }
    echo "$out"
    grep -q "$(forge_project_key in-line): unchanged" <<<"$out" || fail "in-line was not left alone"
    pr="$(forge_open_pr two-roots terragucci/pipeline)"
    [ -n "$pr" ] || fail "no request was opened on two-roots"
    [ -z "$(forge_open_pr in-line terragucci/pipeline)" ] || fail "a request was opened on in-line"
    sha="$(forge_branch_sha two-roots terragucci/pipeline)"
    forge_run two-roots terragucci/pipeline "$sha" push
    if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the request's check ended $RUN_STATUS"; fi
    forge_merge_pr two-roots "$pr"
    sha="$(forge_branch_sha two-roots main)"
    forge_run two-roots main "$sha"
    if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the merged pipeline ended $RUN_STATUS"; fi
    for b in "$p-network" "$p-network-app"; do
      [ "$(bucket_code "$b")" = 200 ] || { forge_logs; fail "$b is not in floci"; }
    done
    log "one request on two-roots, check green, merged, both roots applied in order; in-line unchanged"
    ;;
esac

log "PASS in $(( $(date +%s) - started ))s"
