#!/usr/bin/env bash
# Fill the gaps the validation page shows, one source at a time, on demand.
#
#   just coverage-fill                 print the plan: each step, what it runs, what it fills
#   just coverage-fill <step>...       run those steps, in the order given
#   just coverage-fill all             run every step that has something to fill
#
# Steps, and the stack each holds:
#   forgejo     claims defined with no Forgejo row (just claims)         the shared stack
#   terraform   the binary's claims again (just binary-claims terraform)  the shared stack, the terraform example copy
#   choudoufu   the binary's claims again (just binary-claims choudoufu)  the shared stack, the choudoufu example copy
#   gitlab      claims defined with no GitLab row, then the GitLab captures: boots the lab (needs about
#               4.5 GB of memory and 40 GB of free disk), runs, and takes it down if this step booted it
#   github      the github.com sandbox: prove --record, prove --break --record, then its captures;
#               needs TERRAGUCCI_SANDBOX_TOKEN or a gh token with secrets read and write
#   validation  the per-forge claims (just validation-record gitlab forgejo); it takes the whole stack
#               down before and after, so it runs only with --exclusive
#
# Each step writes its rows into docs-site/src/data/smoke.json or validation.json, or its captures
# under docs-site/src/data/tutorial; review and commit them. `npx tsx scripts/coverage-gaps.ts` lists
# what is still open, including the cells only a new claim can fill. Nothing here runs in CI.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

EXCLUSIVE=""
STEPS=()
for a in "$@"; do
  case "$a" in
    --exclusive) EXCLUSIVE=1 ;;
    all) STEPS+=(forgejo terraform choudoufu gitlab github) ;;
    forgejo|terraform|choudoufu|gitlab|github|validation) STEPS+=("$a") ;;
    *) echo "coverage-fill: unknown step '$a' (forgejo, terraform, choudoufu, gitlab, github, validation, all)" >&2; exit 2 ;;
  esac
done

gaps="$(npx tsx scripts/coverage-gaps.ts --json)"
names() { jq -r "$1" <<<"$gaps" | sort -u | paste -sd' ' -; }
forgejo_claims="$(names '.unrecorded[] | select(.where | test("CLAIMS in stack/smoke.sh")) | .claim')"
gitlab_claims="$(names '.unrecorded[] | select(.where | test("GITLAB_CLAIMS")) | .claim')"
github_unrecorded="$(names '.unrecorded[] | select(.where | test("PROVE_CLAIMS")) | .claim')"
github_weak="$(names '.cells[] | select(.grid == "forge" and .column == "GitHub" and .state == "passes") | .claims[]')"
validation_unrecorded="$(names '.unrecorded[] | select(.where | test("stack/validation.sh")) | .claim')"
stale_for() { jq -r --arg s "$1" '.stale[] | select(.file | endswith("/" + $s + ".json")) | .file' <<<"$gaps"; }

plan() {
  echo "coverage-fill: nothing runs without a step name. What each step would do now:"
  echo
  echo "  forgejo      ${forgejo_claims:-nothing: every Forgejo claim has a row}"
  echo "  terraform    re-run the Terraform claims (BINARY_CLAIMS in stack/smoke.sh); add claims there to fill its 'same code' cells"
  echo "  choudoufu    re-run the choudoufu claims, likewise"
  echo "  gitlab       claims: ${gitlab_claims:-none unrecorded}; captures: $( [ -n "$(stale_for gitlab)" ] && echo stale || echo current)"
  echo "  github       unrecorded: ${github_unrecorded:-none}; not cut out yet: ${github_weak:-none}; captures: $( [ -n "$(stale_for github)" ] && echo stale || echo current)"
  echo "  validation   unrecorded: ${validation_unrecorded:-none} (needs --exclusive)"
  echo
  echo "  Cells only a new claim can fill: npx tsx scripts/coverage-gaps.ts"
}

[ ${#STEPS[@]} -gt 0 ] || { plan; exit 0; }

log() { printf '\n[coverage-fill] %s\n' "$*"; }

for step in "${STEPS[@]}"; do
  case "$step" in
    forgejo)
      if [ -n "$forgejo_claims" ]; then log "forgejo: just claims $forgejo_claims"; just claims "$forgejo_claims"; else log "forgejo: nothing to fill"; fi
      ;;
    terraform|choudoufu)
      log "$step: just binary-claims $step"; just binary-claims "$step"
      ;;
    gitlab)
      booted=""
      if ! docker ps --format '{{.Names}}' | grep -q '^tglab-gitlab$'; then log "gitlab: booting the lab"; just gitlab-lab up; booted=1; fi
      if [ -n "$gitlab_claims" ]; then log "gitlab: just gitlab-claims $gitlab_claims"; just gitlab-claims "$gitlab_claims"; fi
      if [ -n "$(stale_for gitlab)" ]; then log "gitlab: recapturing the GitLab views"; stack/example-gitlab.sh capture; fi
      if [ -n "$booted" ]; then log "gitlab: taking the lab down"; just gitlab-lab down; fi
      ;;
    github)
      log "github: just sandbox prove --record"; just sandbox prove --record docs-site/src/data/validation.json
      log "github: just sandbox prove --break --record"; just sandbox prove --break --record docs-site/src/data/validation.json
      if [ -n "$(stale_for github)" ]; then log "github: recapturing the GitHub views"; just sandbox capture; fi
      ;;
    validation)
      [ -n "$EXCLUSIVE" ] || { echo "coverage-fill: validation takes the whole stack down before and after; run it with --exclusive when nothing else uses the stack" >&2; exit 2; }
      log "validation: just validation-record gitlab forgejo"; just validation-record gitlab forgejo
      ;;
  esac
done

log "done; what is still open:"
npx tsx scripts/coverage-gaps.ts | tail -n +1
