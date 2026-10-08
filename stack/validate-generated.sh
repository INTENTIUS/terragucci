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
#
# The images are the ones the generated pipeline pins by digest; the runner
# (gitlab-runner, or act on the host) pulls each the first time.
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
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORGE="${1:?forge}"
CLAIM="${2:?claim}"
BREAK="${BREAK:-}"
TIMEOUT="${TERRAGUCCI_VALIDATE_TIMEOUT:-900}"
FIXTURE="$HERE/fixtures/s3-bucket"
TERRAGUCCI="$HERE/../node_modules/.bin/terragucci"
BUCKET="terragucci-validate"

log()  { echo "[validate $FORGE $CLAIM] $*"; }
fail() { log "FAIL: $*"; exit 1; }

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "SKIP: Docker is not available"; exit 0; }
case "$CLAIM" in check|apply|reconcile|tg-check|tg-apply|cdf-check|cdf-apply|gate-wait|own-jobs|pr-review|approve) ;; *) echo "claim '$CLAIM' is not implemented for $FORGE (check, apply, reconcile, tg-check, tg-apply, cdf-check, cdf-apply, gate-wait, own-jobs, pr-review)" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:approve) ;; *:approve) echo "approve is implemented for gitlab here; the approve-command smoke claim runs it on Forgejo" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in forgejo:pr-review|gitlab:pr-review) ;; *:pr-review) echo "pr-review is implemented for forgejo and gitlab here" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:gate-wait) ;; *:gate-wait) echo "gate-wait is gitlab's: it checks how GitLab ends a waiting wave's job and status" >&2; exit 2 ;; esac
case "$FORGE:$CLAIM" in gitlab:own-jobs) ;; *:own-jobs) echo "own-jobs is gitlab's: it checks the include init adds to a repo's own .gitlab-ci.yml" >&2; exit 2 ;; esac

case "$FORGE:$CLAIM" in forgejo:check|forgejo:apply|forgejo:reconcile) echo "forgejo's $CLAIM is validate.sh's own; this script runs its tg-* and cdf-* claims" >&2; exit 2 ;; esac

# shellcheck source=forge-github.sh
. "$HERE/forge-$FORGE.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-validate.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
forge_load

ci_image() { (cd "$HERE/.." && npx tsx scripts/images.ts tags | awk '$1 == "tofu" { print $2 }'); }

# One commit of DIR, force-pushed. The message carries a timestamp, so every
# push has a new sha.
push_dir() { # dir remote branch message
  (
    cd "$1"
    [ -d .git ] || git init -q -b "$3"
    git checkout -q -B "$3"
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

# approval: pr-review on GitLab: an approval counts only after the merge
# request's latest version.
run_pr_review_gitlab() {
  local repo=validate-review who="validate-reviewer" pass="validate-$RANDOM-$RANDOM-Aa1" uid rtoken sha
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
    # job's token), so the claim cannot drift from the renderer.
    DEFAULTS="forge: $FORGE
binary: tofu
token_env: $FORGE_TOKEN_ENV"
    (cd "$WORK/in-line" && git init -q -b main && echo "$DEFAULTS" > terragucci.yml && "$TERRAGUCCI" init >/dev/null && rm -f terragucci.yml)
    forge_push "$WORK/in-line" in-line main "Two roots, pipeline in line" >/dev/null
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
