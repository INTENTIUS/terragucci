#!/usr/bin/env bash
#
# Claims on the github and gitlab profiles, run with the pipeline terragucci
# generates for the forge rather than a hand-written one. validate.sh hands
# over here for those forges.
#
#   stack/validate-generated.sh github check
#   stack/validate-generated.sh gitlab apply
#   stack/validate-generated.sh github reconcile
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
#
# BREAK=1 breaks the property each claim is about: check puts the unformatted
# file in the clean push; apply drops the apply job so the run stays green;
# reconcile runs a dry run, which opens nothing.
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
case "$CLAIM" in check|apply|reconcile) ;; *) echo "claim '$CLAIM' is not implemented for $FORGE (check, apply, reconcile)" >&2; exit 2 ;; esac

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

add_unformatted() {
  cat > "$1/infra/unformatted.tf" <<'TF'
locals {
    unformatted   = "tofu fmt rewrites this file"
  also = 1
}
TF
}

bucket_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' -I "$FLOCI/$1" || true; }
msg() { echo "validate $CLAIM $(date -u +%Y-%m-%dT%H:%M:%SZ) $$"; }

started=$(date +%s)
[ -n "$BREAK" ] && log "BREAK=1: breaking the property on purpose; this run must fail"

case "$CLAIM" in
  check)
    forge_reset_repo validate
    prepare "$WORK/clean"
    [ -n "$BREAK" ] && add_unformatted "$WORK/clean"
    sha="$(forge_push "$WORK/clean" validate validate/check "$(msg)")"
    log "pushed the formatted root to validate/check at ${sha:0:8}"
    forge_run validate validate/check "$sha"
    if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the formatted root's run ended '$RUN_STATUS'; expected success"; fi

    prepare "$WORK/dirty"
    add_unformatted "$WORK/dirty"
    sha="$(forge_push "$WORK/dirty" validate validate/check "$(msg)")"
    log "pushed an unformatted file to validate/check at ${sha:0:8}"
    forge_run validate validate/check "$sha"
    [ "$RUN_STATUS" = failure ] || fail "the unformatted root's run ended '$RUN_STATUS'; expected failure"
    grep -q "unformatted.tf" "$RUN_LOG" || { forge_logs; fail "the run failed, but its log does not name unformatted.tf, so it failed somewhere other than the fmt check"; }
    log "the run failed at the fmt check and named infra/unformatted.tf"
    ;;

  apply)
    forge_reset_repo validate
    curl -s -o /dev/null -X DELETE "$FLOCI/$BUCKET" || true
    [ "$(bucket_code "$BUCKET")" = 404 ] || fail "could not clear $BUCKET from floci before the run"
    log "$BUCKET is absent from floci"
    prepare "$WORK/main"
    if [ -n "$BREAK" ]; then
      f="$WORK/main/$PIPELINE_FILE"
      sed -E '/^ {0,2}apply:$/,$d' "$f" > "$f.new" && mv "$f.new" "$f"
      ! grep -qE '^ {0,2}apply:$' "$f" || fail "could not drop the apply job from $PIPELINE_FILE"
    fi
    sha="$(forge_push "$WORK/main" validate main "$(msg)")"
    log "pushed to main at ${sha:0:8}"
    forge_run validate main "$sha"
    if [ "$RUN_STATUS" != success ]; then forge_logs; fail "the apply run ended '$RUN_STATUS'; expected success"; fi
    code="$(bucket_code "$BUCKET")"
    if [ "$code" != 200 ]; then forge_logs; fail "the run went green but $BUCKET is not in floci (HEAD answered $code)"; fi
    log "$BUCKET exists in floci (HEAD $FLOCI/$BUCKET answered 200)"
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
