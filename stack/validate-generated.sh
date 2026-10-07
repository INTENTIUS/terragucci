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
#
# The images are the ones the generated pipeline pins by digest; the runner
# (gitlab-runner, or act on the host) pulls each the first time.
#
# BREAK=1 breaks the property each claim is about: a check claim puts its bad
# file in the clean push; an apply claim drops the apply job so the run stays
# green; reconcile runs a dry run, which opens nothing.
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
case "$CLAIM" in check|apply|reconcile|tg-check|tg-apply|cdf-check|cdf-apply) ;; *) echo "claim '$CLAIM' is not implemented for $FORGE (check, apply, reconcile, tg-check, tg-apply, cdf-check, cdf-apply)" >&2; exit 2 ;; esac

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
