# ── choudoufu estates: gated retags and adoptions ─────────────────────────
# choudoufu/migrate runs wave 1 of a local repo (audit_origin) in the
# choudoufu CI image, with every AWS call through the claim's record store
# proxy, as choudoufu/shared-bucket does. Each root holds SQS queues on floci, whose
# ownership markers (tofu-estate, tofu-address) the provider reads back.

# A root of SQS queues: a live block naming ESTATE, or with ESTATE "-" the
# backend block given in STOCK, then one queue per name.
cdf_queue_root() { # dir estate queue-prefix names...
  local dir="$1" estate="$2" prefix="$3" n
  shift 3
  mkdir -p "$dir"
  {
    if [ "$estate" = - ]; then printf '%s\n' "$CDF_STOCK"
    else
      printf 'terraform {\n  live {\n    estate = "%s"\n\n    record_store "s3" {\n      bucket = "%s"\n    }\n\n    retry {\n      max_attempts = 1\n    }\n  }\n}\n' "$estate" "$CDF_RECORDS"
    fi
    printf '\nterraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n}\n\nprovider "aws" {\n  region                      = "us-east-1"\n  skip_credentials_validation = true\n  skip_requesting_account_id  = true\n  skip_metadata_api_check     = true\n}\n'
    for n in "$@"; do printf '\nresource "aws_sqs_queue" "%s" {\n  name = "%s-%s"\n}\n' "$n" "$prefix" "$n"; done
  } >"$dir/main.tf"
}

# The tofu-estate marker of a queue in floci, or nothing.
cdf_queue_estate() { # queue name
  local url
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$1\"}" 2>/dev/null | jq -r '.QueueUrl // empty')" || return 0
  [ -n "$url" ] || return 0
  sqs ListQueueTags "{\"QueueUrl\":\"$url\"}" 2>/dev/null | jq -r '.Tags["tofu-estate"] // empty'
}

# A stage run in $1/wave, in the choudoufu CI image, with the bundle given
# and every AWS call through the claim's proxy. Sets AUDIT_CODE.
cdf_migrate_stage() { # work bundle log stage-args...
  local work="$1" bundle="$2" logf="$3"
  shift 3
  AUDIT_CODE=0
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e "AWS_ENDPOINT_URL=http://$CDF_ALIAS:4566" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$(image_tag choudoufu)" terragucci stage "$@" >"$work/$logf.log" 2>&1 || AUDIT_CODE=$?
  cat "$work/$logf.log" >&2
  clean_mounted "$work/wave" "$(image_tag choudoufu)"
}

# The changes a tf-plan of the layers given found, from its report: a count, or "failed".
cdf_migrate_planned() { # work bundle layers
  cdf_migrate_stage "$1" "$2" plan-after tf-plan --layers "$3" --binary choudoufu
  [ "$AUDIT_CODE" = 0 ] || { echo failed; return 0; }
  jq '[.roots[].changes[]?] | length' "$1/wave/terragucci-report/report.json" 2>/dev/null || echo failed
}

# The resources a plain choudoufu plan of a root in $1/wave would create, for
# a log line when a claim's next plan is not clean (tf-plan refuses to plan
# while a migration's last run failed).
cdf_root_creates() { # work root
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$1/wave:/repo" -w "/repo/$2" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e "AWS_ENDPOINT_URL=http://$CDF_ALIAS:4566" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 -e TF_IN_AUTOMATION=1 \
    --entrypoint sh "$(image_tag choudoufu)" -c 'choudoufu init -input=false -no-color >/dev/null 2>&1; choudoufu plan -input=false -no-color 2>&1' 2>/dev/null \
    | sed -n 's/^  # \(.*\) will be created$/\1/p' | tr '\n' ' '
  clean_mounted "$1/wave" "$(image_tag choudoufu)"
}

claim_choudoufu/migrate() {
  # Two migrations of one change, on one setup, both applied by wave 1
  # (cdf_migrations below): carve, a retag that moves a queue between two
  # estates, and adopt, which takes a root on s3 state into an estate.
  # BREAK: each migration's property is broken in turn, each on a setup of
  # its own with that migration alone, and the run is caught only when both
  # fail under their breaks:
  #   carve: the retag's write is skipped, so the queue keeps mono's markers,
  #     wave 1 fails, and the next plan of team creates a second jobs queue.
  #   adopt: live-import runs without -approve, so no marker is stamped, wave
  #     1 fails, and the next plan of app creates both queues again.
  log() { echo "[smoke cdf-migrate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" caught="" missed=""
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    cdf_migrations "$work/both" "$bundle" carve adopt || rc=1
    cdf_down "$work"
    [ $rc = 0 ] && log "one change carried both migrations: the jobs queue moved estates by a retag, app's state became an estate with its state left as it was, each approved by its digest, and the next plan of every root shows no change"
    return $rc
  fi
  if break_bundle "$work/carve.mjs" migrate-estate.ts 'await writeRetag(exec, options.binary, plan.places.get(t.to)!, t, log, progress);' 'void 0;'; then
    if cdf_migrations "$work/carve" "$work/carve.mjs" carve; then missed+=" carve"; else caught+=" carve"; fi
  else
    log "the carve BREAK bundle did not build"; caught+=" carve"
  fi
  cdf_proxy_down
  if break_bundle "$work/adopt.mjs" migrate-estate.ts 'const STAMP = "-approve";' 'const STAMP = "-no-color";'; then
    if cdf_migrations "$work/adopt" "$work/adopt.mjs" adopt; then missed+=" adopt"; else caught+=" adopt"; fi
  else
    log "the adopt BREAK bundle did not build"; caught+=" adopt"
  fi
  cdf_down "$work"
  log "under BREAK: caught${caught:- none}; missed${missed:- none}"
  return $([ -z "$missed" ] && echo 1 || echo 0)
}

# The migrations named (carve, adopt or both), in one change, applied by
# wave 1 of one checkout in $1/wave, its origin a bare repo, with the bundle
# given:
#   carve  estate <stamp>-mono (root mono) holds the queues jobs and keep;
#          root team is estate <stamp>-team, with no resources. The change
#          moves the jobs block to team and adds migrations/carve-jobs.yml.
#          The wave proves the retag (each root's plan changes only the queue
#          that moves) and waits. Once approved, live-mv rewrites the queue's
#          markers: it carries tofu-estate <stamp>-team, keep stays in mono,
#          and _gates/tf-migrate/done.jsonl on chant/lifecycle names the
#          retag.
#   adopt  root app holds the queues a and b, its state app.tfstate in the
#          versioned bucket tgca-<stamp>, applied with choudoufu as stock
#          OpenTofu. The change replaces its backend block with a live block
#          naming estate <stamp>-app and adds migrations/adopt-app.yml, whose
#          from names the old state. The wave proves the adoption (live-import
#          verifies both queues) and waits. Once approved, live-import stamps
#          both: they carry tofu-estate <stamp>-app, app.tfstate is still the
#          version it was, the record names that version as the source, and
#          no lock file is left.
# Wave 1 waits for each migration in turn, smoke-approver approves the digest
# it printed, and the wave runs again, up to three runs, until it exits 0
# with every migration applied. A tf-plan of every root right after shows no
# change.
cdf_migrations() { # dir bundle carve|adopt...
  local d="$1" bundle="$2" carve="" adopt="" w n name digest approved="" layers="" all="" first="" got done record was keys rc=0 m
  shift 2
  for m in "$@"; do case "$m" in carve) carve=1 ;; adopt) adopt=1 ;; esac; done
  local tag="$STAMP-$$-$RANDOM"
  local mono="cdfm-$tag-mono" team="cdfm-$tag-team" mprefix="tgs-cdfm-$tag"
  local estate="cdfa-$tag-app" aprefix="tgs-cdfa-$tag" bucket="tgca-$tag"
  mkdir -p "$d"
  if [ -n "$adopt" ]; then versioned_bucket "$bucket" || { log "could not create the state bucket $bucket"; return 1; }; fi
  cdf_proxy_up "$d" || { log "the record store proxy did not start"; return 1; }
  if [ -n "$carve" ]; then
    cdf_queue_root "$d/wave/mono" "$mono" "$mprefix" jobs keep
    cdf_queue_root "$d/wave/team" "$team" "$mprefix"
    first="mono"; all="mono,team"
  fi
  if [ -n "$adopt" ]; then
    CDF_STOCK="$(printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "app.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n' "$bucket")"
    cdf_queue_root "$d/wave/app" - "$aprefix" a b
    first="${first:+$first,}app"; all="${all:+$all,}app"
  fi
  printf '.terraform/\n.terraform.lock.hcl\n.tofu-records/\nterragucci-report/\n' >"$d/wave/.gitignore"
  audit_origin "$d"
  cdf_migrate_stage "$d" "$bundle" first tf-apply --wave 1 --layers "$first" --binary choudoufu --gate never
  [ "$AUDIT_CODE" = 0 ] || { log "the first apply of $first exited $AUDIT_CODE, not 0"; return 1; }
  if [ -n "$carve" ]; then
    got="$(cdf_queue_estate "$mprefix-jobs")"
    [ "$got" = "$mono" ] || { log "carve: after the first apply the jobs queue carries tofu-estate '$got', not $mono"; return 1; }
  fi
  if [ -n "$adopt" ]; then
    was="$(current_version "$bucket" app.tfstate)"
    [ "$(curl -fsS "$FLOCI/$bucket/app.tfstate" | jq -r '[.resources[].name] | join(",")')" = "a,b" ] || { log "adopt: app.tfstate does not hold both queues"; return 1; }
    [ -z "$(cdf_queue_estate "$aprefix-a")" ] || { log "adopt: the stock apply stamped a marker on queue a"; return 1; }
  fi
  # The change: each migration's roots and its file.
  mkdir -p "$d/wave/migrations" "$d/records"
  if [ -n "$carve" ]; then
    cdf_queue_root "$d/wave/mono" "$mono" "$mprefix" keep
    cdf_queue_root "$d/wave/team" "$team" "$mprefix" jobs
    printf 'moves:\n  - from: mono\n    to: team\n    addresses: [aws_sqs_queue.jobs]\n' >"$d/wave/migrations/carve-jobs.yml"
  fi
  if [ -n "$adopt" ]; then
    cdf_queue_root "$d/wave/app" "$estate" "$aprefix" a b
    printf 'backends:\n  - root: app\n    from:\n      backend: s3\n      config:\n        bucket: %s\n        key: app.tfstate\n        region: us-east-1\n        use_lockfile: true\n        use_path_style: true\n' "$bucket" >"$d/wave/migrations/adopt-app.yml"
  fi
  git -C "$d/wave" add -A && git -C "$d/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "the migrations: $*"
  # Wave 1 until it applies, approving each migration it waits for.
  for n in 1 2 3; do
    cdf_migrate_stage "$d" "$bundle" "run-$n" tf-apply --wave 1 --layers "$all" --binary choudoufu --gate never
    cp "$d/wave/terragucci-report/migrations/"*.json "$d/records/" 2>/dev/null || true
    [ "$AUDIT_CODE" = 0 ] && break
    [ "$AUDIT_CODE" = 3 ] || { log "wave 1 run $n exited $AUDIT_CODE, not 0 or 3"; return 1; }
    # The hold chant ends the run on. A run after an approval prints the
    # approved migration's wait first: the hook runs once before chant finds
    # the approval, then again (chant#3847), and holds on the next one.
    w="$(sed -n 's/.*It waits on tf-migrate \/ \([^ .]*\)\. approve: chant approve tf-migrate [^ ]* --plan \([^ ]*\).*/\1 \2/p' "$d/run-$n.log" | tail -1)"
    [ -n "$w" ] || { log "wave 1 run $n waited, but for no migration"; return 1; }
    grep -q "^migration ${w%% *} waits for an approval of digest ${w#* }\. " "$d/run-$n.log" || { log "wave 1 run $n holds on ${w%% *} at ${w#* }, which no migration said it waits for"; return 1; }
    while read -r name digest; do
      case " $approved " in *" $name "*) log "wave 1 run $n waits again for $name, which was approved"; return 1 ;; esac
      # Before its approval, the retag has written nothing.
      if [ "$name" = carve-jobs ]; then
        got="$(cdf_queue_estate "$mprefix-jobs")"
        [ "$got" = "$mono" ] || { log "carve: before the approval the jobs queue carries tofu-estate '$got', not $mono"; rc=1; }
      fi
      migrate_approve "$d/origin.git" "$d/ledger" smoke-approver "$name" "$digest" || { log "could not approve $name"; return 1; }
      approved="$approved $name"
    done <<<"$w"
  done
  [ "$AUDIT_CODE" = 0 ] || { log "wave 1 still waits after three runs"; return 1; }
  cat "$d"/run-*.log >"$d/runs.log"
  if [ -n "$carve" ]; then
    case " $approved " in *" carve-jobs "*) ;; *) log "carve: wave 1 never waited for an approval of the retag"; rc=1 ;; esac
    grep -q "^migration carve-jobs: every change each root plans is one the retag removes; digest " "$d/runs.log" || { log "carve: wave 1 did not prove the retag"; rc=1; }
    grep -q "^migration carve-jobs applied$" "$d/runs.log" || { log "carve: the log does not say the retag applied"; rc=1; }
    got="$(cdf_queue_estate "$mprefix-jobs")"
    [ "$got" = "$team" ] || { log "carve: the jobs queue carries tofu-estate '$got', not $team"; rc=1; }
    got="$(cdf_queue_estate "$mprefix-keep")"
    [ "$got" = "$mono" ] || { log "carve: the keep queue carries tofu-estate '$got', not $mono"; rc=1; }
    done="$(git --git-dir="$d/origin.git" show "chant/lifecycle:_gates/tf-migrate/done.jsonl" 2>/dev/null | grep '"gate":"carve-jobs"' | tail -1)"
    jq -c '{result, change, retags}' <<<"$done" >&2 || true
    [ "$(jq -r '[.result, .change, .retags[0].address, .retags[0].from_estate, .retags[0].to_estate] | join(" ")' <<<"$done" 2>/dev/null)" = "applied retag aws_sqs_queue.jobs $mono $team" ] \
      || { log "carve: chant/lifecycle does not record the retag of aws_sqs_queue.jobs from $mono to $team"; rc=1; }
  fi
  if [ -n "$adopt" ]; then
    case " $approved " in *" adopt-app "*) ;; *) log "adopt: wave 1 never waited for an approval of the adoption"; rc=1 ;; esac
    grep -q "^migration adopt-app: every resource of the state verifies against the live system, and every change the root plans is one the stamp removes; digest " "$d/runs.log" \
      || { log "adopt: wave 1 did not prove the adoption"; rc=1; }
    grep -q "^migration adopt-app applied$" "$d/runs.log" || { log "adopt: the log does not say the adoption applied"; rc=1; }
    for got in a b; do
      [ "$(cdf_queue_estate "$aprefix-$got")" = "$estate" ] || { log "adopt: queue $got carries tofu-estate '$(cdf_queue_estate "$aprefix-$got")', not $estate"; rc=1; }
    done
    [ "$(current_version "$bucket" app.tfstate)" = "$was" ] || { log "adopt: app.tfstate is not the version it was"; rc=1; }
    record="$(cat "$d/records/adopt-app.json" 2>/dev/null)"
    jq -c '{status, change, roots: [.roots[] | {root, location, source}]}' <<<"$record" >&2 || true
    [ "$(jq -r '[.status, .change, .roots[0].location, .roots[0].source.location, .roots[0].source.version_id] | join(" ")' <<<"$record" 2>/dev/null)" = "applied adopt estate $estate s3://$bucket/app.tfstate $was" ] \
      || { log "adopt: the record does not name the estate and the version of the state it adopted"; rc=1; }
    keys="$(curl -fsS "$FLOCI/$bucket?list-type=2" | grep -o '<Key>[^<]*</Key>' | tr '\n' ' ')"
    case "$keys" in *.tflock*) log "adopt: a lock file is left: $keys"; rc=1 ;; esac
  fi
  got="$(cdf_migrate_planned "$d" "$bundle" "$all")"
  [ "$got" = 0 ] || { log "the next plan of $all shows $got change(s), not none; a plan would create: $( [ -n "$carve" ] && cdf_root_creates "$d" team)$( [ -n "$adopt" ] && cdf_root_creates "$d" app)"; rc=1; }
  return $rc
}

claim_init/cdktn_synth() {
  # A CDK Terrain app (fixtures/cdktn) on cdktn 0.24.0 with two stacks, and
  # synth in terragucci.yml. Its .npmrc sets engine-strict, so npm ci stops
  # on a job image whose Node is older than the 22.19 cdktn 0.24 needs. The
  # stacks are synthesized on the host so init finds them under
  # cdktf.out/stacks; the pushed pipeline runs synth itself, since cdktf.out
  # is not committed. The push to main passes check and applies
  # both stacks; a pull request that changes the size of prod in main.js gets
  # a passing terragucci/plan whose job ran cdktn synth before tf-plan and
  # planned prod.
  # BREAK: synth is left out of terragucci.yml, so the pipeline runs no synth
  # step and its checkout holds no stacks to check, apply or plan.
  log() { echo "[smoke cdktn-synth] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cdktn-synth" wf sha head pr jobs id plan_log rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo cdktn-synth || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/cdktn/." "$work/tree/"
  if [ -n "${BREAK:-}" ]; then sed -i.bak '/^synth:/d' "$work/tree/terragucci.yml" && rm -f "$work/tree/terragucci.yml.bak"; fi
  (cd "$work/tree" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host"; drop_work "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  [ -n "${BREAK:-}" ] || grep -q 'npx cdktn synth' "$wf" || { log "the pipeline runs no synth step"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "cdktn-synth: two stacks")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs")"
  log "the push to main ran: $(jq -r '[.[] | "\(.name) \(.status)"] | join(", ")' <<<"$jobs")"
  [ "$(jq -r '.[] | select(.name == "check") | .status' <<<"$jobs")" = success ] || { log "check did not pass on the synthesized stacks"; rc=1; }
  [ "$(jq -r '.[] | select(.name == "apply-wave-1") | .status' <<<"$jobs")" = success ] || { log "apply-wave-1 did not apply the synthesized stacks"; rc=1; }
  if [ $rc = 0 ]; then
    sed -i.bak 's/prod: 3/prod: 5/' "$work/tree/main.js" && rm -f "$work/tree/main.js.bak"
    head="$(push_tree "$work/tree" "$repo" change "cdktn-synth: prod holds 5")" || rc=1
    git -C "$work/tree" checkout -q main
  fi
  if [ $rc = 0 ]; then
    pr="$(pr_open "$repo" change "cdktn-synth: prod holds 5")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(context_state "$repo" "$head" terragucci/plan)" = success ] || { log "terragucci/plan did not pass on pull request $pr"; rc=1; }
    id="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -r '.[] | select(.name == "plan") | .id')"
    plan_log="$(api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null || true)"
    grep -E 'Generated Terraform code|synth at the base|affected: |cdktf.out/stacks/[a-z]+: ' <<<"$plan_log" >&2 || true
    grep -q 'Generated Terraform code for the stacks: dev, prod' <<<"$plan_log" || { log "the plan job did not run cdktn synth"; rc=1; }
    [ "$(grep -n 'Generated Terraform code' <<<"$plan_log" | head -1 | cut -d: -f1)" -lt "$(grep -n 'synth at the base: ' <<<"$plan_log" | head -1 | cut -d: -f1)" ] 2>/dev/null || { log "synth did not run before tf-plan"; rc=1; }
    grep -q "cdktf.out/stacks/prod: Plan:" <<<"$plan_log" || { log "tf-plan did not plan cdktf.out/stacks/prod"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "synth ran before check, apply and tf-plan, which planned the synthesized stack prod"
  return $rc
}

claim_affected/cdktn() {
  # The CDK Terrain app of cdktn-synth (fixtures/cdktn, stacks dev and prod)
  # on main, and a pull request that changes the size of prod in main.js.
  # tf-plan runs the synth command on the base too and compares each stack's
  # synthesized files: the plan job plans prod and not dev, and the plan note
  # says one stack was unchanged and not planned.
  # BREAK: main names an app file that does not exist in cdktf.json, and the
  # pull request puts it back, so synth fails on the base. tf-plan then plans
  # every stack, the unchanged dev with them.
  log() { echo "[smoke cdktn-affected] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cdktn-affected" sha head pr id plan_log notes body rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo cdktn-affected || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/cdktn/." "$work/tree/"
  (cd "$work/tree" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host"; drop_work "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then sed -i.bak 's#"node main.js"#"node gone.js"#' "$work/tree/cdktf.json" && rm -f "$work/tree/cdktf.json.bak"; fi
  sha="$(push_tree "$work/tree" "$repo" main "cdktn-affected: two stacks")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || { drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then sed -i.bak 's#"node gone.js"#"node main.js"#' "$work/tree/cdktf.json" && rm -f "$work/tree/cdktf.json.bak"; fi
  sed -i.bak 's/prod: 3/prod: 5/' "$work/tree/main.js" && rm -f "$work/tree/main.js.bak"
  head="$(push_tree "$work/tree" "$repo" change "cdktn-affected: prod holds 5")" || rc=1
  git -C "$work/tree" checkout -q main
  if [ $rc = 0 ]; then
    pr="$(pr_open "$repo" change "cdktn-affected: prod holds 5")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(context_state "$repo" "$head" terragucci/plan)" = success ] || { log "terragucci/plan did not pass on pull request $pr"; rc=1; }
    id="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -r '.[] | select(.name == "plan") | .id')"
    plan_log="$(api "$URL/api/v1/repos/$repo/actions/jobs/$id/logs" 2>/dev/null || true)"
    grep -E 'synth at the base|every root: |affected: |cdktf.out/stacks/[a-z]+: ' <<<"$plan_log" >&2 || true
    grep -q "cdktf.out/stacks/prod: Plan:" <<<"$plan_log" || { log "tf-plan did not plan cdktf.out/stacks/prod, which changed"; rc=1; }
    if grep -q "cdktf.out/stacks/dev: " <<<"$plan_log"; then log "tf-plan planned cdktf.out/stacks/dev, which the change leaves alone"; rc=1; fi
    notes="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq '[.[] | select(.body | startswith("<!-- terragucci:plan"))]')"
    body="$(jq -r '.[0].body // ""' <<<"$notes")"
    grep -E 'synth command|synthesized root' <<<"$body" >&2 || true
    grep -q '1 synthesized root planned, 1 unchanged and not planned' <<<"$body" || { log "the plan note does not say one stack was unchanged"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "synth ran on the base too: prod differed and planned, dev was unchanged, not planned, and the note says so"
  return $rc
}

# The cdktn fixture's tree in $work/tree for a claim: its terragucci.yml as
# given, its stacks' state in floci under <prefix>/ when one is given (none
# there yet), and its stacks synthesized on the host so init finds them.
cdktn_tree() { # prefix (or ""), terragucci.yml
  local prefix="$1" key
  mkdir -p "$work/tree"
  cp -R "$HERE/fixtures/cdktn/." "$work/tree/"
  printf '%s' "$2" > "$work/tree/terragucci.yml"
  if [ -n "$prefix" ]; then
    PREFIX="$prefix" perl -pi -e 's#^const STATE = "";#const STATE = "$ENV{PREFIX}";#' "$work/tree/main.js"
    curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
    for key in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$prefix/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
      curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
    done
  fi
  (cd "$work/tree" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host"; return 1; }
}

# The lines of one job of a Forgejo workflow.
cdktn_job() { # workflow, job
  awk -v j="  $2:" '$0 == j { on = 1; next } /^  [a-z0-9-]+:$/ { on = 0 } on' "$1"
}

# The pipeline with the synth line taken out of the jobs whose name matches.
cdktn_unsynth() { # workflow, job name pattern (awk)
  awk -v pat="$2" '/^  [a-z0-9-]+:$/ { job = substr($1, 1, length($1) - 1) } !(job ~ pat && index($0, "( set -e; ")) { print }' "$1" > "$1.new" && mv "$1.new" "$1"
}

claim_apply/cdktn() {
  # The CDK Terrain app of cdktn-synth with each stack's state in floci under
  # cdktn-apply/, gate: always, and the dev stack as the canary wave. Each
  # apply wave's job runs synth: on the push to main wave 1 waits at its gate
  # with nothing applied; approved, the next push applies dev alone and wave
  # 2 waits at its own gate; approved, the next push applies prod.
  # BREAK: the apply-wave jobs run no synth, so their checkouts hold no
  # stacks: no wave waits at its gate and nothing applies.
  log() { echo "[smoke cdktn-apply] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cdktn-apply" wf sha job applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo cdktn-apply || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  cdktn_tree cdktn-apply "$(printf 'binary: tofu\nforge: forgejo\ngate: always\nwaves:\n  canary: ["cdktf.out/stacks/dev"]\nsynth: npm ci --no-audit --no-fund && npx cdktn synth\n')" || { drop_work "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  for job in apply-wave-1 apply-wave-2; do
    cdktn_job "$wf" "$job" | grep -q 'npx cdktn synth' || { log "$job runs no synth step"; drop_work "$work"; return 1; }
  done
  [ -z "${BREAK:-}" ] || cdktn_unsynth "$wf" '^apply-wave-'
  sha="$(push_tree "$work/tree" "$repo" main "cdktn-apply: two stacks")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  applied="$(gated_applied cdktn-apply)"
  log "after the first push: run $RUN_STATUS, state for: ${applied:-nothing}"
  [ -z "$applied" ] || { log "a stack applied before wave 1 was approved"; rc=1; }
  run_logs "$repo" "$RUN_ID" | grep -q "terragucci approve wave-1" || { log "wave 1 did not wait at its gate with its approve command"; rc=1; }
  [ $rc = 0 ] && { gated_approve cdktn-apply 1 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "cdktn-apply: after wave 1 was approved")"
    wait_run "$repo" "$sha" || rc=1
    applied="$(gated_applied cdktn-apply)"
    log "after wave 1's approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "dev " ] || { log "dev did not apply alone"; rc=1; }
    run_logs "$repo" "$RUN_ID" | grep -q "terragucci approve wave-2" || { log "wave 2 did not wait at its own gate"; rc=1; }
  fi
  [ $rc = 0 ] && { gated_approve cdktn-apply 2 || rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "cdktn-apply: after wave 2 was approved")"
    wait_run "$repo" "$sha" || rc=1
    applied="$(gated_applied cdktn-apply)"
    log "after wave 2's approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "dev prod " ] || { log "prod did not apply after its approval"; rc=1; }
    curl -fsS "$FLOCI/shop-terraform-state/cdktn-apply/prod.tfstate" | jq -e '.outputs.size.value == 3' >/dev/null || { log "prod's state does not hold the size its stack sets"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "each apply wave synthesized the stacks: dev applied once wave 1 was approved, prod once wave 2 was"
  return $rc
}

claim_tips/cdktn() {
  # The CDK Terrain app of cdktn-synth with gate: never and no canary. The
  # push to main applies both stacks, and the tips job runs synth before
  # respond tips: it opens the canary tip's pull request, which changes
  # terragucci.yml alone, opens no lock file tip, and says the provider pin
  # and lock file tips are left out, since synth writes the stacks' files and
  # git does not hold them.
  # BREAK: the tips job runs no synth, so respond tips finds no stack and
  # opens nothing.
  log() { echo "[smoke cdktn-tips] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cdktn-tips" wf sha pr logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo cdktn-tips || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  cdktn_tree "" "$(printf 'binary: tofu\nforge: forgejo\ngate: never\nsynth: npm ci --no-audit --no-fund && npx cdktn synth\n')" || { drop_work "$work"; return 1; }
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  cdktn_job "$wf" tips | grep -q 'npx cdktn synth' || { log "the tips job runs no synth step"; drop_work "$work"; return 1; }
  [ -z "${BREAK:-}" ] || cdktn_unsynth "$wf" '^tips$'
  sha="$(push_tree "$work/tree" "$repo" main "cdktn-tips: two stacks")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$sha" || rc=1
  [ "$RUN_STATUS" = success ] || { log "the run ended '$RUN_STATUS'"; print_logs "$repo" "$RUN_ID" | tail -40 >&2; rc=1; }
  logs="$(run_logs "$repo" "$RUN_ID")"
  grep -E 'respond tips|left out with synth|terragucci/tip' <<<"$logs" >&2 || true
  pr="$(open_pr "$repo" terragucci/tip/canary)"
  if [ -z "$pr" ]; then
    log "no pull request from terragucci/tip/canary"; rc=1
  else
    [ "$(pr_files "$repo" "$pr")" = terragucci.yml ] || { log "the canary tip changes $(pr_files "$repo" "$pr"), not terragucci.yml"; rc=1; }
    api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.title' | grep -q 'Add a canary wave: cdktf.out/stacks/dev' || { log "the canary tip does not name cdktf.out/stacks/dev"; rc=1; }
  fi
  [ -z "$(open_pr "$repo" terragucci/tip/lock-files)" ] || { log "a lock file tip was opened for files synth writes"; rc=1; }
  grep -q "left out with synth: the provider pin and lock file tips" <<<"$logs" || { log "the tips job does not say why the pin and lock file tips are left out"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the tips job synthesized the stacks and opened the canary tip for cdktf.out/stacks/dev, changing terragucci.yml alone"
  return $rc
}

claim_init/cdktn_refuse() {
  # The CDK Terrain app of cdktn-synth, synthesized on the host. init refuses
  # synth with a drift schedule whose response is the drift pull request (the
  # default), and synth with rollouts, each as a config error saying why:
  # both would edit files synth writes and git does not hold. With
  # respond.drift: attribute init writes a drift job that runs synth and
  # tf-drift, runs no drift pull request, and says why.
  # BREAK: synth is left out of terragucci.yml, so init accepts the drift
  # pull request and rollouts.
  log() { echo "[smoke cdktn-refused] $*" >&2; }
  local work out wf cfg rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cfg="$(printf 'binary: tofu\nforge: forgejo\nsynth: npm ci --no-audit --no-fund && npx cdktn synth')"
  [ -z "${BREAK:-}" ] || cfg="$(printf 'binary: tofu\nforge: forgejo')"
  cdktn_tree "" "$cfg" || { drop_work "$work"; return 1; }
  printf '%s\ndrift: "0 6 * * *"\n' "$cfg" > "$work/tree/terragucci.yml"
  if out="$(cd "$work/tree" && "$TERRAGUCCI" init 2>&1)"; then
    log "init accepted synth with the drift pull request"; rc=1
  else
    grep 'respond.drift' <<<"$out" >&2 || true
    grep -q "respond.drift: the drift pull request writes each live value into a root's own files, and with synth" <<<"$out" || { log "init did not say why the drift pull request is refused"; rc=1; }
  fi
  printf '%s\nrollouts: "*/15 * * * *"\n' "$cfg" > "$work/tree/terragucci.yml"
  if out="$(cd "$work/tree" && "$TERRAGUCCI" init 2>&1)"; then
    log "init accepted synth with rollouts"; rc=1
  else
    grep 'rollouts' <<<"$out" >&2 || true
    grep -q "rollouts: a rollout moves a pin in each root's files or its lock file, and with synth" <<<"$out" || { log "init did not say why rollouts are refused"; rc=1; }
  fi
  printf '%s\ndrift: "0 6 * * *"\nrespond:\n  drift: attribute\n' "$cfg" > "$work/tree/terragucci.yml"
  if (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null 2>&1); then
    wf="$work/tree/.forgejo/workflows/terragucci.yml"
    cdktn_job "$wf" drift > "$work/drift-job"
    grep -q 'npx cdktn synth' "$work/drift-job" || { log "the drift job runs no synth"; rc=1; }
    grep -q 'terragucci stage tf-drift' "$work/drift-job" || { log "the drift job runs no tf-drift"; rc=1; }
    if grep -q 'terragucci respond drift' "$work/drift-job"; then log "the drift job runs the drift pull request"; rc=1; fi
    grep -q 'terragucci: no drift pull request: synth writes the roots' "$work/drift-job" || { log "the drift job does not say why no pull request follows"; rc=1; }
  else
    log "init refused respond.drift: attribute with synth"; rc=1
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "init refused the drift pull request and rollouts with synth, each saying why, and with attribute the drift job synthesizes and runs no pull request"
  return $rc
}

# ── the audit trail ───────────────────────────────────────────────────────
# A repo with one root, app, a terraform_data with local state, whose
# reports go to the bucket under a fresh prefix, and beside it origin.git,
# which holds main and, once a wave records something, chant/lifecycle.
audit_repo() { # work, prefix -> $1/wave and $1/origin.git
  local work="$1" prefix="$2"
  mkdir -p "$work/wave/app"
  printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "first"\n}\n' > "$work/wave/app/main.tf"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  # Under SMOKE_BINARY its root is written for that binary, one estate per prefix under choudoufu.
  bin_prepare && bin_tree "$work/wave" "$prefix" || return 1
  audit_origin "$work"
}

audit_origin() { # work -> commits $1/wave and pushes it to $1/origin.git, its origin as the image sees it
  git init -q --bare "$1/origin.git"
  git -C "$1/wave" init -q -b main
  git -C "$1/wave" add -A && git -C "$1/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke audit"
  git -C "$1/wave" push -q "$1/origin.git" main
  git -C "$1/wave" remote add origin /origin.git
}

audit_in() { # work, command... -> runs it in the CI image in /repo ($1/wave), with /origin.git; AUDIT_BUNDLE names another bundle
  local work="$1" bundle="${AUDIT_BUNDLE:-$HERE/../packages/terragucci/dist/terragucci.mjs}"; shift
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$(image_tag "${AUDIT_IMAGE:-$SMOKE_BINARY}")" "$@"
}

audit_wave() { # work, gate -> AUDIT_CODE, the exit code of wave 1
  AUDIT_CODE=0
  audit_in "$1" terragucci stage tf-apply --wave 1 --layers app --binary "$SMOKE_BINARY" --gate "$2" > "$1/run.log" 2>&1 || AUDIT_CODE=$?
  cat "$1/run.log" >&2
  clean_mounted "$1/wave" "$(image_tag "$SMOKE_BINARY")"
}

audit_run() { # work, flags... -> AUDIT_OUT and AUDIT_CODE of terragucci audit, run in the repo
  local work="$1"; shift
  AUDIT_CODE=0
  AUDIT_OUT="$(audit_in "$work" terragucci audit --link-hours 1 "$@" 2>&1)" || AUDIT_CODE=$?
  printf '%s\n' "$AUDIT_OUT" >&2
  clean_mounted "$work/wave" "$(image_tag "$SMOKE_BINARY")"
}

# The audit setup, which audit/tofu and audit/refused share on OpenTofu:
# audit_repo's repo, its first wave waiting (its exit code in first.code)
# and approved by smoke-approver as smoke-relay relays it. A part copies it
# and commits a reports prefix of its own, so no two runs write one record:
# the request and the approval come from the ledger, which the copy holds.
# Under another binary each part makes its own, since audit_repo writes the
# root for an estate named by its prefix.
audit_make() { # [prefix]
  audit_repo "$work" "${1:-audit-setup-$STAMP}" || return 1
  audit_wave "$work" always
  echo "$AUDIT_CODE" > "$work/first.code"
  [ "$AUDIT_CODE" = 3 ] || return 0
  audit_approve "$work/origin.git" "$work/ledger" smoke-approver wave-1 "" smoke-relay || return 1
  # The ledger clone pushes to the origin it came from: a part clones its own copy.
  rm -rf "$work/ledger"
}

audit_setup() { # work, prefix -> $1 holds the setup, wave 1 approved, its reports going under prefix; AUDIT_FIRST the first run's exit code
  local work="$1" prefix="$2"
  if [ "$SMOKE_BINARY" = tofu ]; then
    setup_local audit audit_make || return 1
    cp -R "$SETUP_DIR/." "$work/" || return 1
    rm -f "$work/ready"
    sed -i.bak "s#^  prefix: .*#  prefix: $prefix#" "$work/wave/terragucci.yml" && rm -f "$work/wave/terragucci.yml.bak"
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "reports under $prefix" || return 1
  else
    ( audit_make "$prefix" ) || return 1
  fi
  AUDIT_FIRST="$(cat "$work/first.code" 2>/dev/null)"
}

audit_approve() { # origin.git, clone dir, actor, gate, [digest], [relayer] -> an approval line on chant/lifecycle: the digest given, else the gate's newest pending one; with a relayer, written by it for the actor (relayedBy)
  local origin="$1" clone="$2" actor="$3" gate="$4" digest="${5:-}" relayer="${6:-}"
  if [ -d "$clone" ]; then git -C "$clone" pull -q --ff-only origin chant/lifecycle || return 1
  else git clone -q -b chant/lifecycle "$origin" "$clone" || return 1; fi
  [ -n "$digest" ] || digest="$(jq -rs --arg g "$gate" '[.[] | select(.kind == "pending" and .gate == $g)] | last | .planDigest // empty' "$clone/_gates/tf-apply.jsonl")"
  [ -n "$digest" ] || { echo "no pending line for $gate" >&2; return 1; }
  # The approval is stamped to the second and must be newer than the pending line, which carries milliseconds.
  sleep 1
  printf '%s\n' "$(jq -cn --arg d "$digest" --arg g "$gate" --arg a "$actor" --arg r "$relayer" --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '{version: 1, kind: "resolution", op: "tf-apply", gate: $g, resolvedBy: $a, timestamp: $t, planDigest: $d} + (if $r == "" then {} else {relayedBy: $r} end)')" >> "$clone/_gates/tf-apply.jsonl"
  git -C "$clone" -c user.name="$actor" -c user.email="$actor@localhost" -c commit.gpgsign=false commit -qam "approve $gate" && git -C "$clone" push -q origin chant/lifecycle
}

audit_record() { # prefix, file -> downloads the record
  curl -fsS -o "$2" "$FLOCI/$REPORT_BUCKET/$1/audit.jsonl"
}

audit_unrecorded() { # origin.git, ledger file, entry kind, record -> each approval or override line of the ledger with no entry of that kind: who, digest, time
  comm -23 <(git -C "$1" show "chant/lifecycle:$2" 2>/dev/null | jq -r 'select(.kind != "pending") | "\(.resolvedBy) \(.planDigest) \(.timestamp)"' | sort) \
    <(jq -r --arg k "$3" 'select(.kind == $k) | "\(.who) \(.digest) \(.at)"' "$4" | sort)
}

claim_report/outcome() {
  # A repo with one root, app, run by stage tf-apply in the CI image with
  # TG_OUTCOME_JSON naming a file. Wave 1 waits (gate always): the file says
  # terragucci.outcome/v1, waiting, exit 3, the set digest, the gate, mode
  # ledger and the terragucci approve command for that digest. smoke-approver
  # approves it and app moves in a new commit: the file says refused, exit 4,
  # reason approval, the digest approved, by whom, app as the root that moved
  # and the command for the new digest. app is then broken HCL: the file says
  # failed, exit 1, with app among failed_roots.
  # BREAK: TG_OUTCOME_JSON is not set, so no file is written.
  log() { echo "[smoke apply-outcome] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="apply-outcome-$STAMP" out approved digest code
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  audit_repo "$work" "$prefix"
  out="$work/wave/.outcome.json"
  outcome_wave() { # -> code, and the outcome file as the run left it
    local bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" asked=(-e TG_OUTCOME_JSON=/repo/.outcome.json)
    [ -z "${BREAK:-}" ] || asked=()
    code=0
    : > "$out"
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
      -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "${asked[@]}" \
      "$image" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate always > "$work/run.log" 2>&1 || code=$?
    grep -E 'wave 1|FAILED' "$work/run.log" >&2 || true
    clean_mounted "$work/wave" "$image"
    log "exit $code; outcome: $(cat "$out" 2>/dev/null)"
  }
  outcome_wave
  [ "$code" = 3 ] || { log "the first run exited $code, not 3: wave 1 did not wait"; rc=1; }
  if [ $rc = 0 ]; then
    digest="$(jq -r '.set_digest // empty' "$out" 2>/dev/null)"
    jq -e --arg d "$digest" '.schema == "terragucci.outcome/v1" and .status == "waiting" and .exit == 3 and .wave == 1 and .roots == ["app"] and .gate.name == "wave-1" and .gate.branch == "chant/lifecycle" and .approval == "waiting" and .approval_mode == "ledger" and .approve_command == ("terragucci approve wave-1 --plan " + $d) and (.waiting_since | length > 0)' "$out" >/dev/null 2>&1 \
      || { log "the waiting outcome is not as expected"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_approve "$work/origin.git" "$work/ledger" smoke-approver wave-1 || { log "could not approve wave 1"; rc=1; }; fi
  if [ $rc = 0 ]; then
    approved="$(jq -rs '[.[] | select(.kind == "resolution" and .gate == "wave-1")] | last | .planDigest' "$work/ledger/_gates/tf-apply.jsonl")"
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "moved"\n}\n' > "$work/wave/app/main.tf"
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "app moves after its approval"
    outcome_wave
    [ "$code" = 4 ] || { log "the run after the approval exited $code, not 4"; rc=1; }
    jq -e --arg a "$approved" '.status == "refused" and .exit == 4 and .refused.reason == "approval" and .refused.approved == $a and .refused.by == "smoke-approver" and .refused.roots == ["app"] and .set_digest != $a and .approve_command == ("terragucci approve wave-1 --plan " + .set_digest) and (.line | startswith("wave 1 changed after approval"))' "$out" >/dev/null 2>&1 \
      || { log "the refused outcome is not as expected"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    printf 'resource "terraform_data" "app" {\n' > "$work/wave/app/broken.tf"
    outcome_wave
    [ "$code" = 1 ] || { log "the run with broken HCL exited $code, not 1"; rc=1; }
    jq -e '.status == "failed" and .exit == 1 and .failed_roots == ["app"] and (has("approve_command") | not)' "$out" >/dev/null 2>&1 \
      || { log "the failed outcome is not as expected"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the outcome file said waiting with its digest and command, refused with the approval and the root that moved, and failed with the root"
  return $rc
}

claim_audit/tofu() {
  # On the audit setup: a repo whose reports go to the bucket, wave 1
  # waiting, and smoke-approver's approval of its digest on chant/lifecycle.
  # The next run applies it.
  # terragucci audit, run in the repo, writes audit.jsonl, audit.html and
  # audit.json to the prefix with a presigned link. Every approval line on the
  # ledger has an entry with its approver, digest and time, the request has
  # one, and the apply names the approval it applied under. The approval is
  # relayed: smoke-relay wrote it for smoke-approver, and its entry says so in
  # detail.relayed_by. terragucci audit
  # --check passes, and terragucci estate links audit.html from its page.
  # BREAK: an approval of wave-2 lands on the ledger after the record was
  # written, so the record lacks it, and --check names it and exits 1.
  log() { echo "[smoke audit] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-$STAMP" approval missing
  image="$(image_tag "$SMOKE_BINARY")"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  audit_setup "$work" "$prefix" || { log "the audit setup failed (under $SMOKE_BINARY)"; drop_work "$work"; return 1; }
  [ "$AUDIT_FIRST" = 3 ] || { log "the first run exited $AUDIT_FIRST, not 3: wave 1 did not wait"; rc=1; }
  if [ $rc = 0 ]; then
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 0 ] || { log "the run after the approval exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE"; rc=1; }
    grep -Eq "X-Amz-Signature=[0-9a-f]{64}" <<<"$AUDIT_OUT" || { log "terragucci audit printed no presigned link"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    audit_approve "$work/origin.git" "$work/ledger" late-approver wave-2 "sha256:$(printf '%064d' 2)" || { log "could not write the late approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }; fi
  if [ $rc = 0 ]; then
    missing="$(audit_unrecorded "$work/origin.git" _gates/tf-apply.jsonl approval "$work/audit.jsonl")"
    [ -z "$missing" ] || { log "approvals on the ledger with no entry in the record: $missing"; rc=1; }
    jq -se '[.[] | select(.schema == "terragucci.audit/v1" and .kind == "approval-requested" and .what == "wave-1" and (.digest | type == "string"))] | length >= 1' "$work/audit.jsonl" >/dev/null \
      || { log "the record has no entry for the request of wave 1"; rc=1; }
    approval="$(jq -rs '[.[] | select(.kind == "approval" and .who == "smoke-approver" and .what == "wave-1")] | last | .id // empty' "$work/audit.jsonl")"
    jq -se --arg a "$approval" '[.[] | select(.id == $a and .detail.relayed_by == "smoke-relay")] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the approval's entry does not say smoke-relay relayed it: $(jq -c 'select(.kind == "approval") | {who, detail}' "$work/audit.jsonl")"; rc=1; }
    jq -se --arg a "$approval" '[.[] | select(.kind == "apply" and .result == "applied" and .who == "smoke-approver" and .detail.approval == $a and .evidence.source == "report")] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the apply of wave 1 does not name the approval it applied under: $(jq -c 'select(.kind == "apply") | {who, result, detail}' "$work/audit.jsonl")"; rc=1; }
    curl -fsS -o /dev/null "$FLOCI/$REPORT_BUCKET/$prefix/audit.html" || { log "no audit.html at $REPORT_BUCKET/$prefix"; rc=1; }
    audit_run "$work" --check
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit --check exited $AUDIT_CODE: the record lacks an entry the sources hold"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci estate --link-hours 1 >&2 || log "terragucci estate exited non-zero"
    clean_mounted "$work/wave" "$image"
    curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html" | grep -q 'href="audit.html" id="audit-trail"' || { log "estate.html does not link audit.html"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the record holds the request, the approval by smoke-approver and the apply that names it, --check passes, and the estate page links it"
  return $rc
}

claim_audit/override() {
  # The policy-wave repo with policy.override and reports in the bucket. Its
  # wave is denied and terragucci audit runs; smoke-approver overrides the
  # denial, the next run applies app (its report replaces the denied one) and
  # terragucci audit runs again. The record keeps the refusal
  # (denied-by-policy, app denied) and appends the override (who, the reason,
  # the rules and the plan digest of the denial it answers) and the apply
  # that names it. Every override line on the ledger has an entry, and
  # --check passes.
  # BREAK: the override is written after the record, so the record lacks it,
  # and --check names it and exits 1.
  log() { echo "[smoke audit-override] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-override-$STAMP" missing
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  mkdir -p "$work/wave"
  cp -R "$HERE/fixtures/policy-wave/." "$work/wave/"
  printf 'policy:\n  engine: conftest\n  path: policy\n  override: [smoke-approver]\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" >> "$work/wave/terragucci.yml"
  audit_origin "$work"
  audit_wave "$work" never
  [ "$AUDIT_CODE" = 1 ] || { log "the first run exited $AUDIT_CODE, not 1: the policy did not deny the wave"; rc=1; }
  # A scheduled audit records the refusal while its report stands; the run after the override replaces that report.
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE after the denial"; rc=1; }
  fi
  if [ $rc = 0 ]; then policy_override_write "$work" smoke-approver || rc=1; fi
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    audit_wave "$work" never
    [ "$AUDIT_CODE" = 0 ] || { log "the run after the override exited $AUDIT_CODE, not 0"; rc=1; }
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE after the apply"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }; fi
  if [ $rc = 0 ]; then
    missing="$(audit_unrecorded "$work/origin.git" _gates/policy-override.jsonl override "$work/audit.jsonl")"
    [ -z "$missing" ] || { log "overrides on the ledger with no entry in the record: $missing"; rc=1; }
    jq -se '[.[] | select(.kind == "refused" and .result == "denied-by-policy" and .detail.denied == ["app"] and (.detail.rules.app | length > 0))] | length >= 1' "$work/audit.jsonl" >/dev/null \
      || { log "the record has no denied-by-policy refusal of app: $(jq -c 'select(.kind == "refused")' "$work/audit.jsonl")"; rc=1; }
    jq -se '[.[] | select(.kind == "override" and .what == "app" and .who == "smoke-approver" and .detail.reason == "smoke: the probe goes out" and (.detail.rules | length > 0) and (.detail.plan_digest | type == "string"))] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the override of app is not in the record with its reason, rules and plan digest: $(jq -c 'select(.kind == "override")' "$work/audit.jsonl")"; rc=1; }
    jq -se '[.[] | select(.kind == "apply" and .result == "applied" and .detail.overrides[0].root == "app" and .detail.overrides[0].by == "smoke-approver")] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the apply of app does not name its override: $(jq -c 'select(.kind == "apply")' "$work/audit.jsonl")"; rc=1; }
    audit_run "$work" --check
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit --check exited $AUDIT_CODE: the record lacks an entry the sources hold"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the record holds the denial of app, the override by smoke-approver with its reason and rules, and the apply under it"
  return $rc
}

claim_audit/refused() {
  # On the audit setup, where wave 1 waits and smoke-approver approves its
  # digest (relayed by smoke-relay); then app changes in
  # a new commit and wave 1 runs again. Its plans moved, so it applies nothing
  # and exits 4, and its report says why in waves[].refused. terragucci audit
  # records the refusal: changed-after-approval, by smoke-approver, with the
  # digest approved and app as the root that moved.
  # BREAK: app does not change, so the second run applies and nothing is refused.
  log() { echo "[smoke audit-refused] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-refused-$STAMP" approved
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  audit_setup "$work" "$prefix" || { log "the audit setup failed"; drop_work "$work"; return 1; }
  [ "$AUDIT_FIRST" = 3 ] || { log "the first run exited $AUDIT_FIRST, not 3: wave 1 did not wait"; rc=1; }
  if [ $rc = 0 ]; then
    approved="$(git -C "$work/origin.git" show chant/lifecycle:_gates/tf-apply.jsonl | jq -rs '[.[] | select(.kind == "resolution" and .gate == "wave-1")] | last | .planDigest')"
    if [ -z "${BREAK:-}" ]; then
      printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "moved"\n}\n' > "$work/wave/app/main.tf"
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "app moves after its approval"
    fi
    audit_wave "$work" always
    log "the run after the approval exited $AUDIT_CODE"
    jq -e '.waves[0].refused | .reason == "approval" and .by == "smoke-approver" and .roots == ["app"]' "$work/wave/terragucci-report/report.json" >/dev/null 2>&1 \
      || { log "the wave report does not say it was refused after the approval: $(jq -c '.waves[0]' "$work/wave/terragucci-report/report.json" 2>/dev/null)"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }; fi
  if [ $rc = 0 ]; then
    jq -se --arg d "$approved" '[.[] | select(.kind == "refused" and .result == "changed-after-approval" and .who == "smoke-approver" and .detail.approved == $d and .detail.moved == ["app"] and .digest != $d)] | length == 1' "$work/audit.jsonl" >/dev/null \
      || { log "the record has no changed-after-approval refusal of wave 1: $(jq -c 'select(.kind == "refused" or .kind == "apply") | {kind, who, result, digest, detail}' "$work/audit.jsonl")"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the refused wave is in the record: changed after the approval by smoke-approver, app moved"
  return $rc
}

claim_audit/control() {
  # A control repo names two projects, smoke.local/audit/a and b, each a repo
  # of its own (a.git and b.git, named by url:) copying its reports to the
  # bucket. Wave 1 of each waits; smoke-approver approves a, and its next run
  # applies (its report replaces the waiting run of the same commit).
  # terragucci audit, run in the control repo, fetches each project
  # chant/lifecycle from its url and reads each project reports: one record
  # holds the request, approval and apply of a and the request and waiting
  # run of b, and --check passes.
  # BREAK: the url of b names a repo that does not exist, so its ledger
  # cannot be read: the command exits 1 and the record lacks the request of b.
  log() { echo "[smoke audit-control] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="audit-control-$STAMP" p code burl=/work/b.git out bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  [ -n "${BREAK:-}" ] && burl=/work/missing.git
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  control_in() { # dir under /work, command...
    local dir="$1"; shift
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/work" -w "/work/$dir" \
      -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      -e GITHUB_SERVER_URL=http://smoke.local -e "GITHUB_REPOSITORY=audit/$dir" "$image" "$@"
  }
  for p in a b; do
    estate_project "$work/$p" "$(printf '  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s' "$REPORT_BUCKET" "$prefix")"
    git init -q --bare "$work/$p.git"
    git -C "$work/$p" push -q "$work/$p.git" main
    git -C "$work/$p" remote add origin "/work/$p.git"
    code=0
    control_in "$p" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate always >&2 || code=$?
    clean_mounted "$work/$p" "$image"
    [ "$code" = 3 ] || { log "wave 1 of $p exited $code, not 3"; rc=1; }
  done
  if [ $rc = 0 ]; then audit_approve "$work/a.git" "$work/a-ledger" smoke-approver wave-1 || { log "could not approve wave 1 of a"; rc=1; }; fi
  if [ $rc = 0 ]; then
    code=0
    control_in a terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate always >&2 || code=$?
    clean_mounted "$work/a" "$image"
    [ "$code" = 0 ] || { log "wave 1 of a exited $code after its approval, not 0"; rc=1; }
  fi
  mkdir -p "$work/control"
  cat > "$work/control/terragucci.yml" <<YAML
defaults:
  reports:
    bucket: s3://$REPORT_BUCKET
    endpoint: http://floci:4566
    prefix: $prefix
projects:
  smoke.local/audit/a:
    url: /work/a.git
  smoke.local/audit/b:
    url: $burl
YAML
  if [ $rc = 0 ]; then
    code=0
    out="$(control_in control terragucci audit --link-hours 1 2>&1)" || code=$?
    printf '%s\n' "$out" >&2
    clean_mounted "$work/control" "$image"
    [ "$code" = 0 ] || { log "terragucci audit exited $code"; rc=1; }
    audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(jq -rs '[.[] | select(.project == "smoke.local/audit/a") | "\(.kind):\(.result)"] | sort | join(",")' "$work/audit.jsonl")" = "apply:applied,approval-requested:waiting,approval:unsigned" ] \
      || { log "the entries of a are $(jq -rsc '[.[] | select(.project == "smoke.local/audit/a") | "\(.kind):\(.result)"] | sort' "$work/audit.jsonl")"; rc=1; }
    [ "$(jq -rs '[.[] | select(.project == "smoke.local/audit/b") | "\(.kind):\(.result)"] | sort | join(",")' "$work/audit.jsonl")" = "apply:waiting,approval-requested:waiting" ] \
      || { log "the entries of b are $(jq -rsc '[.[] | select(.project == "smoke.local/audit/b") | "\(.kind):\(.result)"] | sort' "$work/audit.jsonl")"; rc=1; }
    code=0
    control_in control terragucci audit --check >&2 || code=$?
    clean_mounted "$work/control" "$image"
    [ "$code" = 0 ] || { log "terragucci audit --check exited $code"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "one record holds both projects: the request, approval and apply of a and the request and waiting run of b"
  return $rc
}

# ── the resource inventory ───────────────────────────────────────────────
# The example's envs/dev/platform and envs/dev/orders roots and the service
# module, in a repo whose reports go to the bucket under a fresh prefix. Each
# root keeps local state and its resources get a name of their own (env
# i<stamp> in place of dev), so the claim shares nothing with the example.
inventory_repo() { # work, prefix -> $1/wave with the two roots and the module, and $1/origin.git
  local work="$1" prefix="$2" env="i$STAMP" root
  mkdir -p "$work/wave/envs/dev" "$work/wave/modules/service"
  cp "$EXAMPLE/modules/service/"*.tf "$work/wave/modules/service/"
  for root in platform orders; do
    mkdir -p "$work/wave/envs/dev/$root"
    cp "$EXAMPLE/envs/dev/$root/main.tf" "$EXAMPLE/envs/dev/$root/.terraform.lock.hcl" "$work/wave/envs/dev/$root/"
    # Under choudoufu each root stays an s3 backend, which binary-tree.py makes an estate in the record store.
    [ "$SMOKE_BINARY" = choudoufu ] || perl -0pi -e 's/backend "s3" \{.*?\n  \}\n/backend "local" {}\n/s; s/backend = "s3"\n  config = \{.*?\n  \}/backend = "local"\n  config = {\n    path = "..\/platform\/terraform.tfstate"\n  }/s' \
      "$work/wave/envs/dev/$root/main.tf"
  done
  perl -pi -e "s/\"shop-dev-logs\"/\"shop-$env-logs\"/" "$work/wave/envs/dev/platform/main.tf"
  perl -pi -e "s/env(\s+)= \"dev\"/env\$1= \"$env\"/" "$work/wave/envs/dev/orders/main.tf"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  bin_prepare && bin_tree "$work/wave" "$prefix" || return 1
  audit_origin "$work"
}

claim_estate/inventory() {
  # inventory_repo's two roots apply in two waves, platform then orders, each
  # copying its report to the bucket. terragucci estate then lists every
  # resource of both roots: estate.json has each root with its resources by
  # address, type and provider and the project's count of each type, and
  # estate.html shows each root and resource. No name of a resource, which
  # the plans hold as values, reaches inventory.json or the page.
  # BREAK: the orders root's list is dropped from inventory.json before the
  # page is built, so the page lists platform alone.
  log() { echo "[smoke inventory] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="inventory-$STAMP" project inv page html wave reg="module.service.aws_s3_object.registration"
  # choudoufu admits no aws_s3_object under live markers: binary-tree.py keeps its content in a terraform_data.
  [ "$SMOKE_BINARY" != choudoufu ] || reg="module.service.terraform_data.registration"
  image="$(image_tag "$SMOKE_BINARY")"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  inventory_repo "$work" "$prefix" || { log "the repo was not written for $SMOKE_BINARY"; drop_work "$work"; return 1; }
  for wave in 1 2; do
    [ $rc = 0 ] || break
    AUDIT_CODE=0
    audit_in "$work" terragucci stage tf-apply --wave "$wave" --layers 'envs/dev/platform;envs/dev/orders' --binary "$SMOKE_BINARY" --gate never > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "wave $wave exited $AUDIT_CODE, not 0"; rc=1; }
  done
  if [ $rc = 0 ]; then
    project="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" | jq -r '.reports[0].project // empty')"
    inv="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/$project/inventory.json")" || { log "no inventory.json at $REPORT_BUCKET/$prefix/$project"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    jq '.roots |= map(select(.root != "envs/dev/orders"))' <<<"$inv" | curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @- "$FLOCI/$REPORT_BUCKET/$prefix/$project/inventory.json" || { log "could not drop the orders list"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -c '.projects[].inventory | {resources, types, roots: [.roots[] | {root, wave, resources: [.resources[] | "\(.address) \(.type)"]}]}' <<<"$page" >&2
    [ "$(jq -r '[.projects[].inventory.roots[]?.root] | join(",")' <<<"$page")" = "envs/dev/orders,envs/dev/platform" ] \
      || { log "the page lists the roots $(jq -c '[.projects[].inventory.roots[]?.root]' <<<"$page"), not envs/dev/orders and envs/dev/platform"; rc=1; }
    jq -e '[.projects[].inventory.roots[]? | select(.root == "envs/dev/platform") | .resources[] | select(.address == "aws_s3_bucket.logs" and .type == "aws_s3_bucket" and (.provider | endswith("hashicorp/aws")))] | length == 1' <<<"$page" >/dev/null \
      || { log "envs/dev/platform does not list aws_s3_bucket.logs"; rc=1; }
    jq -e --arg reg "$reg" '[.projects[].inventory.roots[]? | select(.root == "envs/dev/orders") | .resources[].address] as $a | ["module.service.aws_dynamodb_table.records[0]", "module.service.aws_s3_bucket.files", $reg, "module.service.aws_sqs_queue.jobs"] - $a | length == 0' <<<"$page" >/dev/null \
      || { log "envs/dev/orders does not list the service module's bucket, queue, table and registration"; rc=1; }
    jq -e '[.projects[].inventory.types[]? | select(.type == "aws_s3_bucket") | .count] == [2]' <<<"$page" >/dev/null \
      || { log "the project does not count two aws_s3_bucket: $(jq -c '[.projects[].inventory.types]' <<<"$page")"; rc=1; }
    grep -q '<tbody class="inv" data-root="envs/dev/orders">' <<<"$html" || { log "estate.html shows no envs/dev/orders"; rc=1; }
    grep -q '<code>module.service.aws_sqs_queue.jobs</code>' <<<"$html" || { log "estate.html does not list the jobs queue"; rc=1; }
    if grep -q "shop-i$STAMP-" <<<"$inv$page$html"; then log "a resource name, a value in the plan, reached inventory.json or the page"; rc=1; fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the estate page lists both roots' resources by root and type, and no value"
  return $rc
}

# ── the estate's dependency graph ─────────────────────────────────────────
# The example's dev roots and module in $1/wave, their states in the state
# bucket given on floci and their resource names stamped; and in $1/billing a
# second repo whose one root, invoices, reads dev platform's state.
graph_repos() { # work, prefix, state bucket -> $1/wave and $1/origin.git, $1/billing/wave and $1/billing/origin.git
  local work="$1" prefix="$2" state="$3" env="g$STAMP" root
  mkdir -p "$work/wave/envs/dev" "$work/wave/modules/service" "$work/billing/wave/invoices"
  cp "$EXAMPLE/modules/service/"*.tf "$work/wave/modules/service/"
  for root in "$EXAMPLE"/envs/dev/*/; do
    root="$(basename "$root")"
    mkdir -p "$work/wave/envs/dev/$root"
    cp "$EXAMPLE/envs/dev/$root/main.tf" "$EXAMPLE/envs/dev/$root/.terraform.lock.hcl" "$work/wave/envs/dev/$root/"
    perl -pi -e "s/\"shop-terraform-state\"/\"$state\"/; s/\"shop-dev-logs\"/\"shop-$env-logs\"/; s/env(\s+)= \"dev\"/env\$1= \"$env\"/" "$work/wave/envs/dev/$root/main.tf"
  done
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "billing/invoices.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\ndata "terraform_remote_state" "platform" {\n  backend = "s3"\n  config = {\n    bucket         = "%s"\n    key            = "envs/dev/platform.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "invoices" {\n  input = data.terraform_remote_state.platform.outputs.logs_bucket\n}\n' "$state" "$state" > "$work/billing/wave/invoices/main.tf"
  cp "$work/wave/terragucci.yml" "$work/billing/wave/terragucci.yml"
  # Written for SMOKE_BINARY as one tree, so under choudoufu billing's read of
  # platform's state becomes a read of the estate platform's root owns.
  bin_prepare && bin_tree "$work" "$prefix" --config wave/terragucci.yml --config billing/wave/terragucci.yml || return 1
  audit_origin "$work"
  audit_origin "$work/billing"
}

# The edges the example's own files name: for each dev root, each
# terraform_remote_state key it reads and the dev root whose backend holds
# that key, as "<upstream> <reader>" lines, sorted. Read from the example, not
# from terragucci.
example_edges() {
  local dir root key up
  for dir in "$EXAMPLE"/envs/dev/*/; do
    root="envs/dev/$(basename "$dir")"
    for key in $(perl -0ne 'while (/data "terraform_remote_state"[^{]*\{.*?key\s*=\s*"([^"]+)"/sg) { print "$1\n" }' "$dir/main.tf"); do
      for up in "$EXAMPLE"/envs/dev/*/; do
        KEY="$key" perl -0ne 'exit(/backend "s3" \{[^}]*key\s*=\s*"\Q$ENV{KEY}\E"/s ? 0 : 1)' "$up/main.tf" && echo "envs/dev/$(basename "$up") $root"
      done
    done
  done | sort
}

claim_estate/graph() {
  # graph_repos' shop applies wave 1 (platform) under gate never; its run
  # view then gives the blast radius of that change: platform, and every dev
  # root that reads its state. Wave 2 (the four services) plans and waits
  # under gate always. billing, a second project, applies invoices, which
  # reads platform's state. terragucci estate then draws the graph: an edge
  # for every state the example's files read (example_edges, from the files
  # and not from terragucci), each a path in estate.html, and the edge from
  # the shop's platform to billing's invoices, between projects. The shop's
  # run view has a timeline: wave 1's plan and apply, ended, and wave 2's
  # plan and its wait at the gate, open.
  # BREAK: orders' read of platform is dropped from the shop's run.json
  # before the page is built, so the graph loses that edge.
  log() { echo "[smoke estate-graph] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="graph-$STAMP" state="tg-graph-$STAMP" layers sha key view page html want got edge from to
  image="$(image_tag "$SMOKE_BINARY")"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$state" || { log "could not make the state bucket $state"; drop_work "$work"; return 1; }
  graph_repos "$work" "$prefix" "$state" || { log "the repos were not written for $SMOKE_BINARY"; drop_work "$work"; return 1; }
  want="$(example_edges)"
  log "the example's edges: $(tr '\n' ';' <<<"$want")"
  [ "$(wc -l <<<"$want" | tr -d ' ')" -ge 4 ] || { log "the example names fewer than four reads of a state: $want"; rc=1; }
  layers='envs/dev/platform;envs/dev/email,envs/dev/orders,envs/dev/payments,envs/dev/search'
  sha="$(git -C "$work/wave" rev-parse HEAD)"
  key="$prefix/repo/runs/$sha"
  if [ $rc = 0 ]; then
    AUDIT_CODE=0
    audit_in "$work" terragucci stage tf-apply --wave 1 --layers "$layers" --binary "$SMOKE_BINARY" --gate never > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$key/run.html")" || { log "no run.html at $REPORT_BUCKET/$key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q '<div id="blast" data-roots="1" data-downstream="4">' <<<"$html" || { log "the run view's blast radius is not platform and its four readers: $(grep -o '<div id="blast"[^>]*>' <<<"$html")"; rc=1; }
    for to in email orders payments search; do
      grep -q "<li class=\"downstream\" data-root=\"envs/dev/$to\" data-depth=\"1\"><code>envs/dev/$to</code>, wave 2: reads <code>envs/dev/platform</code></li>" <<<"$html" || { log "the blast radius does not name envs/dev/$to reading platform"; rc=1; }
    done
    grep -q '<g class="node changed" data-project="repo" data-root="envs/dev/platform"' <<<"$html" || { log "the run view's graph does not mark platform as changed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    AUDIT_CODE=0
    audit_in "$work" terragucci stage tf-apply --wave 2 --layers "$layers" --binary "$SMOKE_BINARY" --gate always > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 3 ] || { log "wave 2 exited $AUDIT_CODE, not 3 (waiting)"; rc=1; }
    AUDIT_CODE=0
    audit_in "$work/billing" env GITHUB_REPOSITORY=smoke/billing terragucci stage tf-apply --wave 1 --layers invoices --binary "$SMOKE_BINARY" --gate never > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/billing/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "billing's wave 1 exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    view="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$key/run.json")" || { log "no run.json at $REPORT_BUCKET/$key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    log "the shop's spans: $(jq -c '[.waves[] | {number, state, spans: [.spans[]? | {phase, end: (.end != null)}]}]' <<<"$view")"
    jq -e '(.waves[0].spans | map(select(.end != null) | .phase) | index("plan") != null and index("apply") != null) and (.waves[1].spans | (map(select(.phase == "plan" and .end != null)) | length) == 1 and (map(select(.phase == "gate" and .end == null)) | length) == 1)' <<<"$view" >/dev/null \
      || { log "the run view's timeline does not hold wave 1's plan and apply, ended, and wave 2's plan and open gate wait"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$key/run.html")"
    grep -q '<rect class="span gate open" data-phase="gate" data-open' <<<"$html" || { log "run.html draws no open gate wait"; rc=1; }
    grep -q '<rect class="span apply" data-phase="apply"' <<<"$html" || { log "run.html draws no apply"; rc=1; }
    if [ -n "${BREAK:-}" ]; then
      jq '(.roots[] | select(.root == "envs/dev/orders") | .reads) |= map(select(. != "envs/dev/platform"))' <<<"$view" | curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @- "$FLOCI/$REPORT_BUCKET/$key/run.json" || { log "could not drop orders' read"; rc=1; }
    fi
  fi
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    got="$(jq -r '.graph.edges[]? | select(.from.project == "repo" and .to.project == "repo") | "\(.from.root) \(.to.root)"' <<<"$page" | sort)"
    log "the graph's edges in the shop: $(tr '\n' ';' <<<"$got")"
    [ "$got" = "$want" ] || { log "the graph's edges are not the example's: missing $(comm -23 <(echo "$want") <(echo "$got") | tr '\n' ';') extra $(comm -13 <(echo "$want") <(echo "$got") | tr '\n' ';')"; rc=1; }
    while read -r from to; do
      [ -n "$from" ] || continue
      grep -q "<path class=\"edge\" data-from=\"repo $from\" data-to=\"repo $to\"" <<<"$html" || { log "estate.html draws no edge from $from to $to"; rc=1; }
    done <<<"$want"
    edge="$(jq -c '[.graph.edges[]? | select(.from.project != .to.project)]' <<<"$page")"
    log "between projects: $edge"
    [ "$edge" = '[{"from":{"project":"repo","root":"envs/dev/platform"},"to":{"project":"github.com/smoke/billing","root":"invoices"}}]' ] || { log "the graph does not have billing's invoices reading the shop's platform, alone, between projects"; rc=1; }
    grep -q '<path class="edge cross" data-from="repo envs/dev/platform" data-to="github.com/smoke/billing invoices"' <<<"$html" || { log "estate.html draws no dashed edge between the projects"; rc=1; }
    [ "$(jq '[.graph.nodes[]? | select(.project == "repo")] | length' <<<"$page")" = "$(wc -l <<<"$want" | tr -d ' ' | awk '{ print $1 + 1 }')" ] || { log "the graph does not hold every shop root: $(jq -c '[.graph.nodes[]?]' <<<"$page")"; rc=1; }
    if grep -q '<script[^>]*src=' <<<"$html"; then log "estate.html loads a script"; rc=1; fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the estate graph holds every edge the example reads and the one between projects, and the run view gives the blast radius and each wave's plan, gate wait and apply"
  return $rc
}

# ── state versions ────────────────────────────────────────────────────────
# One root, app, a terraform_data whose state is app.tfstate in a bucket of
# its own on floci (s3 backend, use_lockfile), in a repo whose reports go to
# the reports bucket under a fresh prefix.
state_versions_repo() { # work, prefix, state bucket, input -> $1/wave and $1/origin.git
  local work="$1" prefix="$2" bucket="$3"
  mkdir -p "$work/wave/app"
  state_versions_root "$work" "$bucket" "$4"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
}

state_versions_root() { # work, state bucket, input
  printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "app.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$2" "$3" > "$1/wave/app/main.tf"
}

claim_state/versions() {
  # state_versions_repo's root applies in tf-apply wave 1, then again with a
  # new input. Each wave's log names the state's version, and its upload adds
  # it to the project's states.json. terragucci estate then lists app's two
  # versions, newest first: each a version id floci holds for app.tfstate,
  # the newest the object's current one. No input value or the state's
  # lineage reaches states.json or the page.
  # BREAK: the state bucket's versioning is never turned on, so the page says
  # versions are off for app and lists no version.
  log() { echo "[smoke state-versions] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="states-$STAMP" bucket="tgsv-$STAMP" n project states page html ids held current lineage
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket?versioning" -H 'content-type: application/xml' \
      --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
      || { log "could not turn on versioning for $bucket"; return 1; }
  fi
  state_versions_repo "$work" "$prefix" "$bucket" "sv-$STAMP-1"
  for n in 1 2; do
    [ $rc = 0 ] || break
    if [ $n = 2 ]; then
      state_versions_root "$work" "$bucket" "sv-$STAMP-2"
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "app input 2"
    fi
    AUDIT_CODE=0
    audit_in "$work" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "apply $n exited $AUDIT_CODE, not 0"; rc=1; }
    grep -q "^app: state s3://$bucket/app.tfstate" "$work/run.log" || { log "apply $n printed no state line for app"; rc=1; }
  done
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    project="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" | jq -r '.reports[0].project // empty')"
    states="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/$project/states.json")" || { log "no states.json at $REPORT_BUCKET/$prefix/$project"; rc=1; }
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -c '.projects[].states[]? | {root, backend, location, versioning, note, versions: [.versions[] | {version_id, wave, finished}]}' <<<"$page" >&2
    if [ -n "${BREAK:-}" ]; then
      grep -q '<code>app</code>: s3 <code>s3://'"$bucket"'/app.tfstate</code>, <span class="warn">versions are off</span>' <<<"$html" \
        && log "the page says versions are off for app" || log "the page does not say versions are off for app"
    fi
    ids="$(jq -r '[.projects[].states[]? | select(.root == "app") | .versions[].version_id] | join(" ")' <<<"$page")"
    [ "$(jq -r '[.projects[].states[]? | select(.root == "app") | .versioning] | join(",")' <<<"$page")" = "on" ] || { log "the page does not say app's bucket keeps versions"; rc=1; }
    [ "$(wc -w <<<"$ids" | tr -d ' ')" = 2 ] || { log "the page lists app's versions as [$ids], not two"; rc=1; }
    jq -e '[.projects[].states[]? | select(.root == "app") | .versions | (map(.finished) == (map(.finished) | sort | reverse))] == [true]' <<<"$page" >/dev/null || { log "app's versions are not newest first"; rc=1; }
    [ "$(jq -r '[.roots[] | select(.root == "app") | .versions[].version_id] | join(" ")' <<<"$states")" = "$ids" ] || { log "states.json and the page disagree on app's versions"; rc=1; }
    held="$(curl -fsS "$FLOCI/$bucket?versions&prefix=app.tfstate" | grep -o '<VersionId>[^<]*</VersionId>' | sed 's/<[^>]*>//g' | tr '\n' ' ')"
    for n in $ids; do
      case " $held " in *" $n "*) ;; *) log "version $n is not one floci holds for app.tfstate ($held)"; rc=1 ;; esac
      grep -q "<code>$n</code>" <<<"$html" || { log "estate.html does not list version $n"; rc=1; }
    done
    current="$(curl -fsS -o /dev/null -D - "$FLOCI/$bucket/app.tfstate" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }')"
    [ "${ids%% *}" = "$current" ] || { log "the newest version listed is ${ids%% *}, and app.tfstate's current version is $current"; rc=1; }
    lineage="$(curl -fsS "$FLOCI/$bucket/app.tfstate" | jq -r '.lineage // empty')"
    if grep -q "sv-$STAMP-" <<<"$states$page$html"; then log "an input value from the state reached states.json or the page"; rc=1; fi
    if [ -n "$lineage" ] && grep -q "$lineage" <<<"$states$page$html"; then log "the state's lineage reached states.json or the page"; rc=1; fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the estate page lists app's two state versions, newest first, each one the bucket holds, and no state content"
  return $rc
}

# The state-versions repo as Terragrunt units: root.hcl keeps each unit's
# state in the claim's bucket under its path, and live/app takes its one
# resource from modules/app, so it runs from Terragrunt's cache.
tg_state_versions_repo() { # work, prefix, state bucket, input -> $1/wave and $1/origin.git
  local work="$1" prefix="$2" bucket="$3"
  mkdir -p "$work/wave/live/app" "$work/wave/modules/app"
  printf 'remote_state {\n  backend = "s3"\n  generate = {\n    path      = "backend.tf"\n    if_exists = "overwrite_terragrunt"\n  }\n  config = {\n    bucket         = "%s"\n    key            = "${path_relative_to_include()}/terraform.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n' "$bucket" > "$work/wave/root.hcl"
  printf 'variable "input" {\n  type = string\n}\n\nresource "terraform_data" "app" {\n  input = var.input\n}\n' > "$work/wave/modules/app/main.tf"
  tg_state_versions_unit "$work" "$4"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
}

tg_state_versions_unit() { # work, input
  printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "../../modules/app"\n}\n\ninputs = {\n  input = "%s"\n}\n' "$2" > "$1/wave/live/app/terragrunt.hcl"
}

claim_state/terragrunt_versions() {
  # A Terragrunt unit, live/app, whose state is in a versioned bucket on floci
  # and whose module comes through Terragrunt's cache, applies in tf-apply
  # --terragrunt wave 1, then again with a new input. Each wave's log names
  # the unit's state and its version, read from the unit's remote_state block,
  # and its upload adds it to states.json. terragucci estate then lists
  # live/app's two versions, newest first, each one floci holds for its key,
  # the newest the object's current one, and no input value.
  # BREAK: the bucket's versioning is never turned on, so no version is listed.
  log() { echo "[smoke tg-state-versions] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="tgstates-$STAMP" bucket="tgtsv-$STAMP" key="live/app/terraform.tfstate" n project states page ids held current
  image="$(image_tag terragrunt)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket?versioning" -H 'content-type: application/xml' \
      --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
      || { log "could not turn on versioning for $bucket"; return 1; }
  fi
  tg_state_versions_repo "$work" "$prefix" "$bucket" "tsv-$STAMP-1"
  for n in 1 2; do
    [ $rc = 0 ] || break
    if [ $n = 2 ]; then
      tg_state_versions_unit "$work" "tsv-$STAMP-2"
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "live/app input 2"
    fi
    AUDIT_CODE=0
    AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true terragucci stage tf-apply --wave 1 --layers live/app --binary tofu --gate never --terragrunt > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "apply $n exited $AUDIT_CODE, not 0"; rc=1; }
    grep -q "^live/app: state s3://$bucket/$key" "$work/run.log" || { log "apply $n printed no state line for live/app"; rc=1; }
  done
  if [ $rc = 0 ]; then
    AUDIT_IMAGE=terragrunt audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    project="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" | jq -r '.reports[0].project // empty')"
    states="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/$project/states.json")" || { log "no states.json at $REPORT_BUCKET/$prefix/$project"; rc=1; }
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -c '.projects[].states[]? | {root, backend, location, versioning, note, versions: [.versions[] | {version_id, wave}]}' <<<"$page" >&2
    ids="$(jq -r '[.projects[].states[]? | select(.root == "live/app") | .versions[].version_id] | join(" ")' <<<"$page")"
    [ "$(jq -r '[.projects[].states[]? | select(.root == "live/app") | .versioning] | join(",")' <<<"$page")" = "on" ] || { log "the page does not say live/app's bucket keeps versions"; rc=1; }
    [ "$(wc -w <<<"$ids" | tr -d ' ')" = 2 ] || { log "the page lists live/app's versions as [$ids], not two"; rc=1; }
    [ "$(jq -r '[.roots[] | select(.root == "live/app") | .versions[].version_id] | join(" ")' <<<"$states")" = "$ids" ] || { log "states.json and the page disagree on live/app's versions"; rc=1; }
    held="$(curl -fsS "$FLOCI/$bucket?versions&prefix=$key" | grep -o '<VersionId>[^<]*</VersionId>' | sed 's/<[^>]*>//g' | tr '\n' ' ')"
    for n in $ids; do
      case " $held " in *" $n "*) ;; *) log "version $n is not one floci holds for $key ($held)"; rc=1 ;; esac
    done
    current="$(curl -fsS -o /dev/null -D - "$FLOCI/$bucket/$key" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }')"
    [ "${ids%% *}" = "$current" ] || { log "the newest version listed is ${ids%% *}, and $key's current version is $current"; rc=1; }
    if grep -q "tsv-$STAMP-" <<<"$states$page"; then log "an input value from the state reached states.json or the page"; rc=1; fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the estate page lists live/app's two state versions, read from its remote_state block, newest first, each one the bucket holds"
  return $rc
}

# A Terragrunt repo of three units in a chain, its state in a bucket of its
# own on floci: live/vpc, live/app with a dependency block on live/vpc, and
# live/web with one on live/app. Each unit's module takes an input and has an
# output id.
tg_graph_repo() { # work, prefix, state bucket -> $1/wave and $1/origin.git
  local work="$1" prefix="$2" bucket="$3" u
  mkdir -p "$work/wave/modules/thing"
  printf 'remote_state {\n  backend = "s3"\n  generate = {\n    path      = "backend.tf"\n    if_exists = "overwrite_terragrunt"\n  }\n  config = {\n    bucket         = "%s"\n    key            = "${path_relative_to_include()}/terraform.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n' "$bucket" > "$work/wave/root.hcl"
  printf 'variable "input" {\n  type = string\n}\n\nresource "terraform_data" "this" {\n  input = var.input\n}\n\noutput "id" {\n  value = terraform_data.this.id\n}\n' > "$work/wave/modules/thing/main.tf"
  for u in vpc app web; do mkdir -p "$work/wave/live/$u"; done
  printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "../../modules/thing"\n}\n\ninputs = {\n  input = "vpc"\n}\n' > "$work/wave/live/vpc/terragrunt.hcl"
  for u in app:vpc web:app; do
    printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "../../modules/thing"\n}\n\ndependency "up" {\n  config_path  = "../%s"\n  mock_outputs = { id = "mock" }\n}\n\ninputs = {\n  input = dependency.up.outputs.id\n}\n' "${u#*:}" > "$work/wave/live/${u%%:*}/terragrunt.hcl"
  done
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  printf '.terragrunt-cache/\nterragucci-report/\n' > "$work/wave/.gitignore"
  audit_origin "$work"
}

claim_estate/terragrunt_graph() {
  # tg_graph_repo's chain of units: tf-plan --terragrunt of live/vpc alone
  # writes a plan note whose blast radius names live/vpc as changing and
  # live/app (depth 1) and live/web (depth 2) as the units downstream, each
  # with the unit it depends on. tf-apply --terragrunt wave 1 then applies
  # live/vpc, and its run view in the bucket holds the three units by wave,
  # each with the unit its dependency block names, and the same blast radius.
  # terragucci estate draws the graph: the edges live/vpc to live/app and
  # live/app to live/web, each a path in estate.html.
  # BREAK: live/web's edge to live/app is dropped from run.json before the
  # page is built, so the graph loses it.
  log() { echo "[smoke tg-estate-graph] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="tggraph-$STAMP" bucket="tggraph-$STAMP" layers='live/vpc;live/app;live/web' sha key view page html note got want
  image="$(image_tag terragrunt)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  tg_graph_repo "$work" "$prefix" "$bucket"
  sha="$(git -C "$work/wave" rev-parse HEAD)"
  key="$prefix/repo/runs/$sha"
  AUDIT_CODE=0
  AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true terragucci stage tf-plan --terragrunt --binary tofu --root live/vpc --out terragucci-report > "$work/plan.log" 2>&1 || AUDIT_CODE=$?
  cat "$work/plan.log" >&2
  clean_mounted "$work/wave" "$image"
  [ "$AUDIT_CODE" = 0 ] || { log "tf-plan exited $AUDIT_CODE, not 0"; rc=1; }
  if [ $rc = 0 ]; then
    note="$(cat "$work/wave/terragucci-report/note.md" 2>/dev/null)"
    # shellcheck disable=SC2016 # the backticks are the note's markdown
    grep -qF '**Blast radius:** 1 unit changes (`live/vpc`), and 2 units downstream depend on them:' <<<"$note" || { log "the plan note's blast radius is not live/vpc and its two dependents: $(grep -F 'Blast radius' <<<"$note")"; rc=1; }
    # shellcheck disable=SC2016
    grep -qF -- '- `live/app` (wave 2) depends on `live/vpc`; not planned in this run' <<<"$note" || { log "the note does not list live/app depending on live/vpc"; rc=1; }
    # shellcheck disable=SC2016
    grep -qF -- '- `live/web` (wave 3) depends on `live/app`; not planned in this run' <<<"$note" || { log "the note does not list live/web depending on live/app"; rc=1; }
    jq -e '.blast.downstream | map({root, depth}) == [{"root":"live/app","depth":1},{"root":"live/web","depth":2}]' "$work/wave/terragucci-report/report.json" >/dev/null || { log "report.json's blast is not live/app then live/web: $(jq -c .blast "$work/wave/terragucci-report/report.json")"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    AUDIT_CODE=0
    AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true terragucci stage tf-apply --wave 1 --layers "$layers" --binary tofu --gate never --terragrunt > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    view="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$key/run.json")" || { log "no run.json at $REPORT_BUCKET/$key"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$key/run.html")" || { log "no run.html at $REPORT_BUCKET/$key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    log "the run view's units: $(jq -c '[.roots[] | {root, wave, reads}]' <<<"$view")"
    [ "$(jq -c '[.roots[] | [.root, .wave, .reads]]' <<<"$view")" = '[["live/vpc",1,[]],["live/app",2,["live/vpc"]],["live/web",3,["live/app"]]]' ] || { log "the run view does not hold each unit by wave with the unit it depends on"; rc=1; }
    grep -q '<div id="blast" data-roots="1" data-downstream="2">' <<<"$html" || { log "the run view's blast radius is not live/vpc and its two dependents: $(grep -o '<div id="blast"[^>]*>' <<<"$html")"; rc=1; }
    grep -q '<g class="node changed" data-project="repo" data-root="live/vpc"' <<<"$html" || { log "the run view's graph does not mark live/vpc as changed"; rc=1; }
    if [ -n "${BREAK:-}" ]; then
      jq '(.roots[] | select(.root == "live/web") | .reads) |= map(select(. != "live/app"))' <<<"$view" | curl -fsS -o /dev/null -X PUT -H 'content-type: application/json' --data-binary @- "$FLOCI/$REPORT_BUCKET/$key/run.json" || { log "could not drop live/web's edge"; rc=1; }
    fi
  fi
  if [ $rc = 0 ]; then
    AUDIT_IMAGE=terragrunt audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    want="$(printf 'live/app live/web\nlive/vpc live/app')"
    got="$(jq -r '.graph.edges[]? | "\(.from.root) \(.to.root)"' <<<"$page" | sort)"
    log "the graph's edges: $(tr '\n' ';' <<<"$got")"
    [ "$got" = "$want" ] || { log "the graph's edges are not the units' dependency edges: missing $(comm -23 <(echo "$want") <(echo "$got") | tr '\n' ';') extra $(comm -13 <(echo "$want") <(echo "$got") | tr '\n' ';')"; rc=1; }
    while read -r from to; do
      grep -q "<path class=\"edge\" data-from=\"repo $from\" data-to=\"repo $to\"" <<<"$html" || { log "estate.html draws no edge from $from to $to"; rc=1; }
    done <<<"$want"
    [ "$(jq -c '[.graph.nodes[]? | [.root, .wave]] | sort' <<<"$page")" = '[["live/app",2],["live/vpc",1],["live/web",3]]' ] || { log "the graph does not hold every unit by wave: $(jq -c '[.graph.nodes[]?]' <<<"$page")"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the plan note and the run view give live/vpc's blast radius through both dependents, and the estate graph holds each unit by wave with both dependency edges"
  return $rc
}

claim_estate/terragrunt_remote_state() {
  # tg_graph_repo's units take their backend from root.hcl's remote_state,
  # whose key is "${path_relative_to_include()}/terraform.tfstate".
  # tf-apply --terragrunt wave 1 applies live/vpc, and the run view in the
  # bucket holds live/vpc with the state that key names for it. billing, a
  # second project with one plain root, invoices, reads that state through
  # terraform_remote_state and applies its wave 1. terragucci estate then
  # draws an edge from the Terragrunt project's live/vpc to billing's
  # invoices, between projects.
  # BREAK: the bundle leaves path_relative_to_include() unread, so live/vpc's
  # key is an expression, the run view holds no state for it, and the graph
  # has no edge between the projects.
  log() { echo "[smoke tg-remote-state] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image tofu bundle="" rc=0 prefix="tgrs-$STAMP${BREAK:+b}" bucket="tgrs-$STAMP${BREAK:+b}" layers='live/vpc;live/app;live/web' sha key view page html edge
  image="$(image_tag terragrunt)"
  tofu="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  docker image inspect "$tofu" >/dev/null 2>&1 || { log "no CI image $tofu; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    break_bundle "$bundle" detect.ts '(all, name: string | undefined) => relTo(name) ?? all)' '(all) => all)' || { drop_work "$work"; return 1; }
  fi
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; rc=1; }
  if [ $rc = 0 ]; then
    tg_graph_repo "$work" "$prefix" "$bucket"
    mkdir -p "$work/billing/wave/invoices"
    printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "billing/invoices.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\ndata "terraform_remote_state" "vpc" {\n  backend = "s3"\n  config = {\n    bucket         = "%s"\n    key            = "live/vpc/terraform.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "invoices" {\n  input = data.terraform_remote_state.vpc.outputs.id\n}\n' "$bucket" "$bucket" > "$work/billing/wave/invoices/main.tf"
    printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/billing/wave/terragucci.yml"
    audit_origin "$work/billing"
    sha="$(git -C "$work/wave" rev-parse HEAD)"
    key="$prefix/repo/runs/$sha"
    AUDIT_CODE=0
    # Under BREAK the broken bundle cuts this wave's run view; billing and the estate run the plain one.
    AUDIT_BUNDLE="$bundle" AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true terragucci stage tf-apply --wave 1 --layers "$layers" --binary tofu --gate never --terragrunt > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "the Terragrunt project's wave 1 exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    view="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$key/run.json")" || { log "no run.json at $REPORT_BUCKET/$key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    log "the run view's units: $(jq -c '[.roots[] | {root, wave, state}]' <<<"$view")"
    jq -e --arg b "$bucket" '.roots[] | select(.root == "live/vpc") | .state == {bucket: $b, key: "live/vpc/terraform.tfstate"}' <<<"$view" >/dev/null \
      || { log "the run view does not hold live/vpc with the state its remote_state names"; rc=1; }
    AUDIT_CODE=0
    AUDIT_IMAGE=tofu audit_in "$work/billing" env GITHUB_REPOSITORY=smoke/billing terragucci stage tf-apply --wave 1 --layers invoices --binary tofu --gate never > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/billing/wave" "$tofu"
    [ "$AUDIT_CODE" = 0 ] || { log "billing's wave 1 exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    AUDIT_IMAGE=terragrunt audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    edge="$(jq -c '[.graph.edges[]? | select(.from.project != .to.project)]' <<<"$page")"
    log "between projects: $edge"
    [ "$edge" = '[{"from":{"project":"repo","root":"live/vpc"},"to":{"project":"github.com/smoke/billing","root":"invoices"}}]' ] || { log "the graph does not have billing's invoices reading the Terragrunt project's live/vpc, alone, between projects"; rc=1; }
    grep -q '<path class="edge cross" data-from="repo live/vpc" data-to="github.com/smoke/billing invoices"' <<<"$html" || { log "estate.html draws no dashed edge from live/vpc to invoices"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "live/vpc holds the state its remote_state names in the run view, and the estate graph draws its edge to billing's invoices"
  return $rc
}

# ── Terragrunt parity: drift, migrations, pins, choudoufu, stacks ────────

# A command in a CI image (the Terragrunt one unless TG_IN_IMAGE names
# another), in DIR, the way a job runs it: Terragrunt's variables, the bundle
# built from this tree, floci, and the forge token. Extra `docker run`
# arguments come before --.
tg_in_image() { # dir, docker run args (up to --), command...
  local dir="$1" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"; shift
  local -a extra=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do extra+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$dir:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e TG_NON_INTERACTIVE=true -e TERRAGUCCI_FORGEJO_TOKEN="${TOKEN:-}" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    ${extra[@]+"${extra[@]}"} "${TG_IN_IMAGE:-$(tg_image)}" "$@"
}

# A Terragrunt tree with one unit, live/app, whose queue module reads its
# visibility timeout from the unit's inputs (timeout = 30), its state on floci
# under KEY, and a terragucci.yml that names the scratch repo. Leaves it in
# $1/tree with origin the repo as the stack's network reaches it.
tg_queue_tree() { # work, repo, queue, state key prefix
  local tree="$1/tree"
  mkdir -p "$tree/live/app" "$tree/modules/queue"
  printf 'remote_state {\n  backend      = "s3"\n  disable_init = true\n  generate = {\n    path      = "backend.tf"\n    if_exists = "overwrite_terragrunt"\n  }\n  config = {\n    bucket         = "shop-terraform-state"\n    key            = "%s/${path_relative_to_include()}/terraform.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\ngenerate "provider" {\n  path      = "provider.tf"\n  if_exists = "overwrite_terragrunt"\n  contents  = <<-EOF\n    provider "aws" {\n      region            = "us-east-1"\n      s3_use_path_style = true\n    }\n  EOF\n}\n' "$4" > "$tree/root.hcl"
  # The queue carries a tag: floci reads an untagged queue's tags as {} where the state holds null, a tags drift no run clears.
  printf 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n}\n\nvariable "name" {\n  type = string\n}\n\nvariable "timeout" {\n  type = number\n}\n\nresource "aws_sqs_queue" "jobs" {\n  name                       = var.name\n  visibility_timeout_seconds = var.timeout\n  tags                       = { owner = "smoke" }\n}\n' > "$tree/modules/queue/main.tf"
  printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "../../modules/queue"\n}\n\ninputs = {\n  name    = "%s"\n  timeout = 30\n}\n' "$3" > "$tree/live/app/terragrunt.hcl"
  printf 'binary: tofu\nforge: forgejo\nurl: http://forgejo:3000/%s\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\n' "$2" > "$tree/terragucci.yml"
  printf '.terragrunt-cache/\nterragucci-report/\nterragucci-respond/\n' > "$tree/.gitignore"
  git -C "$tree" init -q -b main
  git -C "$tree" remote add origin "http://$USER:$TOKEN@forgejo:3000/$2.git"
}

# Apply live/app of a queue tree as committed, in the Terragrunt image.
tg_queue_apply() { # tree
  tg_in_image "$1" -e TG_TF_PATH=tofu -- terragrunt run --no-color --working-dir live/app -- apply -auto-approve -input=false -no-color >&2
}

# The stage tf-drift of a queue tree, with the drift issue on the scratch repo
# and the extra `docker run` arguments given; with a second argument "respond"
# the drift response runs after it as the pipeline's drift job runs it.
tg_queue_drift() { # tree, repo, respond|"", docker run args...
  local tree="$1" repo="$2" then="$3"; shift 3
  local cmd="terragucci stage tf-drift --terragrunt --binary tofu --forge forgejo --report-url http://forgejo:3000/$repo/actions"
  [ "$then" = respond ] && cmd="$cmd; rc=\$?; if [ \"\$rc\" -eq 0 ]; then terragucci respond drift --mode apply --binary tofu || true; fi; exit \"\$rc\""
  tg_in_image "$tree" -e TG_TF_PATH=tofu -e "GITHUB_REPOSITORY=$repo" -e GITHUB_SERVER_URL=http://forgejo:3000 -e GITHUB_API_URL=http://forgejo:3000/api/v1 -e "TG_TOKEN=$TOKEN" "$@" -- sh -c "$cmd" >&2
}

claim_drift/terragrunt_attribute() {
  # A scratch repo with one Terragrunt unit, live/app, whose module sets its
  # queue's visibility timeout from the unit's inputs, is applied to floci;
  # then the timeout is changed in floci, outside Terraform. With
  # respond.drift: attribute, tf-drift --terragrunt must open the drift issue
  # with "Who changed it" under live/app, naming the person the audit log
  # gives for the timeout. floci has no CloudTrail and the image has no aws
  # CLI, so the run's `aws` is the stand-in drift-attribute uses, and the
  # claim checks the run asked it about this queue by name.
  # BREAK: the config leaves respond.drift at its default, so the unit's drift
  # is attributed to nobody and the issue says nothing of who.
  log() { echo "[smoke tg-drift-attribute] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-drift-attribute" queue="tg-attr-u-$STAMP" key="tgattr-$STAMP" tree url issues body rc=0
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo tg-drift-attribute || return 1
  tg_queue_tree "$work" "$repo" "$queue" "$key"
  [ -n "${BREAK:-}" ] || printf 'respond:\n  drift: attribute\n' >> "$tree/terragucci.yml"
  push_tree "$tree" "$repo" main "a unit whose queue takes its timeout from the unit's inputs" >/dev/null || return 1
  tg_queue_apply "$tree" || { log "the first apply failed"; return 1; }
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r .QueueUrl)"
  sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null || { log "could not change $queue's timeout"; return 1; }
  mkdir -p "$work/smoke"
  cat > "$work/smoke/aws" <<'SH'
#!/bin/sh
echo "$*" >> /smoke/aws-calls.log
[ "$1 $2" = "cloudtrail lookup-events" ] || { echo "the smoke stand-in answers only cloudtrail lookup-events" >&2; exit 1; }
cat <<'JSON'
{"Events":[{"EventName":"SetQueueAttributes","EventTime":"2026-10-01T09:00:00Z","CloudTrailEvent":"{\"eventName\":\"SetQueueAttributes\",\"eventTime\":\"2026-10-01T09:00:00Z\",\"readOnly\":false,\"userAgent\":\"aws-cli/2.17.0\",\"userIdentity\":{\"type\":\"IAMUser\",\"userName\":\"alice\",\"arn\":\"arn:aws:iam::000000000000:user/alice\"}}"}]}
JSON
SH
  chmod +x "$work/smoke/aws"
  tg_queue_drift "$tree" "$repo" "" -v "$work/smoke:/smoke" -v "$work/smoke/aws:/usr/local/bin/aws:ro" || true
  clean_mounted "$tree" "$(tg_image)"
  if [ ! -f "$tree/terragucci-report/report.json" ]; then
    log "the drift run wrote no report"; rc=1
  else
    jq -e '[.roots[] | select(.path == "live/app") | .changes[] | .attributes[]?.path] | index("visibility_timeout_seconds")' "$tree/terragucci-report/report.json" >/dev/null \
      || { log "the report does not show live/app's timeout drifted"; rc=1; }
    grep -q "AttributeValue=$queue" "$work/smoke/aws-calls.log" 2>/dev/null || { log "the run never asked the audit log about $queue"; rc=1; }
    issues="$(api "$URL/api/v1/repos/$repo/issues?state=open&type=issues&limit=50" | jq -c '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))]')"
    [ "$(jq length <<<"$issues")" = 1 ] || { log "expected one open drift issue, found $(jq length <<<"$issues")"; rc=1; }
    body="$(jq -r '.[0].body // ""' <<<"$issues")"
    awk '/^#### /{ f = index($0, "`live/app`") > 0 } f' <<<"$body" | grep -qx -- '- Who changed it:' || { log "the issue has no 'Who changed it' under live/app"; rc=1; }
    # shellcheck disable=SC2016 # the backticks are the issue's markdown
    grep -Fq '`aws_sqs_queue.jobs` `visibility_timeout_seconds`: a person (audit log: SetQueueAttributes by alice at 2026-10-01T09:00:00Z)' <<<"$body" \
      || { log "the issue does not name alice for live/app's timeout"; rc=1; }
    [ $rc = 0 ] || grep -A8 'Who changed it' <<<"$body" | sed 's/^/[smoke tg-drift-attribute]   /' >&2 || true
  fi
  sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key/live/app/terraform.tfstate" || true
  drop_work "$work" "$(tg_image)" 2>/dev/null || true
  [ $rc = 0 ] && log "the drift issue lists who changed it under live/app: alice, from the audit log, for visibility_timeout_seconds"
  return $rc
}

claim_respond/terragrunt_drift() {
  # A scratch repo with one Terragrunt unit, live/app, whose module sets its
  # queue's visibility timeout from the unit's inputs (timeout = 30), is
  # applied to floci; then the timeout is set to 45 in floci. The drift job's
  # two steps, tf-drift --terragrunt and then respond drift, must open one
  # pull request from terragucci/drift that changes live/app/terragrunt.hcl
  # alone, its input now timeout = 45, and leaves the module every unit
  # shares as it was.
  # BREAK: the timeout is not changed, so there is no drift and no pull request.
  log() { echo "[smoke tg-drift-pr] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-drift-pr" queue="tg-dpr-$STAMP" key="tgdpr-$STAMP" tree url pr files sha rc=0
  docker image inspect "$(tg_image)" >/dev/null 2>&1 || { log "no CI image $(tg_image); run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo tg-drift-pr || return 1
  tg_queue_tree "$work" "$repo" "$queue" "$key"
  push_tree "$tree" "$repo" main "a unit whose queue takes its timeout from the unit's inputs" >/dev/null || return 1
  tg_queue_apply "$tree" || { log "the first apply failed"; return 1; }
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r .QueueUrl)"
  if [ -z "${BREAK:-}" ]; then
    sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null || { log "could not change $queue's timeout"; return 1; }
  fi
  tg_queue_drift "$tree" "$repo" respond || log "the drift job's script exited non-zero"
  clean_mounted "$tree" "$(tg_image)"
  pr="$(open_pr "$repo" terragucci/drift)"
  if [ -z "$pr" ]; then
    log "no drift pull request"; rc=1
  else
    files="$(pr_files "$repo" "$pr")"
    [ "$files" = "live/app/terragrunt.hcl" ] || { log "the pull request changes $files, not live/app/terragrunt.hcl alone"; rc=1; }
    sha="$(remote_head "$repo" terragucci/drift)"
    [ -n "$sha" ] || { log "terragucci/drift has no head"; rc=1; }
    if [ -n "$sha" ]; then
      file_at "$repo" terragucci/drift "$sha" live/app/terragrunt.hcl | grep -Eq '^  timeout = 45$' || { log "live/app/terragrunt.hcl on the branch does not set timeout = 45"; rc=1; }
      file_at "$repo" terragucci/drift "$sha" modules/queue/main.tf | grep -q 'visibility_timeout_seconds = var.timeout' || { log "the module changed on the branch"; rc=1; }
    fi
  fi
  sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key/live/app/terraform.tfstate" || true
  drop_work "$work" "$(tg_image)" 2>/dev/null || true
  [ $rc = 0 ] && log "pull request $pr writes the live timeout into live/app's inputs, and leaves the shared module alone"
  return $rc
}

# A unit of the Terragrunt migrate fixture: its module under modules/<unit>
# holds a terraform_data per name, and the unit calls it through Terragrunt's
# cache. The state is <unit>/terraform.tfstate in the claim's bucket.
tg_migrate_unit() { # work, unit, names...
  local work="$1" unit="$2" n; shift 2
  mkdir -p "$work/wave/live/$unit" "$work/wave/modules/$unit"
  printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "../../modules/%s"\n}\n' "$unit" > "$work/wave/live/$unit/terragrunt.hcl"
  : > "$work/wave/modules/$unit/main.tf"
  for n in "$@"; do printf 'resource "terraform_data" "%s" {\n  input = "mg-%s-%s"\n}\n\n' "$n" "$STAMP" "$n" >> "$work/wave/modules/$unit/main.tf"; done
}

tg_migrate_wave() { # work, log name, layers -> AUDIT_CODE of wave 1
  AUDIT_CODE=0
  AUDIT_IMAGE=terragrunt audit_in "$1" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true terragucci stage tf-apply --wave 1 --layers "$3" --binary tofu --gate never --terragrunt > "$1/$2.log" 2>&1 || AUDIT_CODE=$?
  cat "$1/$2.log" >&2
  clean_mounted "$1/wave" "$(image_tag terragrunt)"
}

claim_migrate/terragrunt_split() {
  # Terragrunt unit live/mono calls a module holding terraform_data.keep and
  # terraform_data.moved, its state in a versioned bucket of the claim's own
  # on floci, applied by wave 1 of tf-apply --terragrunt. A commit moves the
  # moved block to a new unit, live/split, and adds
  # migrations/split-moved.yml. Wave 1 proves the migration, each unit
  # prepared by Terragrunt, and waits for its digest; smoke-approver approves
  # it on chant/lifecycle, and wave 1 runs again: it writes both units'
  # states under their lock files, plans both with no change, and applies
  # nothing. live/mono's state then holds keep alone and live/split's moved;
  # the record places each unit's state at its remote_state key and names
  # its versions before and after; no lock file is left. The pipeline step
  # around it (stage tf-plan printing the digest the wave waits for,
  # done.jsonl, no input value in the record) is migrate/split's.
  # BREAK: after the approval live/mono's state is written again with the
  # same body, a new version, so the wave refuses (exit 4) naming live/mono.
  log() { echo "[smoke tg-migrate-split] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 bucket="tgms-$STAMP" digest record keys mono split v
  image="$(image_tag terragrunt)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket?versioning" -H 'content-type: application/xml' \
    --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
    || { log "could not turn on versioning for $bucket"; return 1; }
  mkdir -p "$work/wave"
  printf 'remote_state {\n  backend = "s3"\n  generate = {\n    path      = "backend.tf"\n    if_exists = "overwrite_terragrunt"\n  }\n  config = {\n    bucket         = "%s"\n    key            = "${path_relative_to_include()}/terraform.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n' "$bucket" > "$work/wave/root.hcl"
  tg_migrate_unit "$work" mono keep moved
  printf 'binary: tofu\n' > "$work/wave/terragucci.yml"
  printf '.terragrunt-cache/\nterragucci-report/\n' > "$work/wave/.gitignore"
  audit_origin "$work"
  tg_migrate_wave "$work" first live/mono
  [ "$AUDIT_CODE" = 0 ] || { log "the first apply of live/mono exited $AUDIT_CODE, not 0"; rc=1; }
  if [ $rc = 0 ]; then
    tg_migrate_unit "$work" mono keep
    tg_migrate_unit "$work" split moved
    mkdir -p "$work/wave/migrations"
    printf 'moves:\n  - from: live/mono\n    to: live/split\n    addresses: [terraform_data.moved]\n' > "$work/wave/migrations/split-moved.yml"
    git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "split moved out of live/mono"
  fi
  if [ $rc = 0 ]; then
    tg_migrate_wave "$work" waits 'live/mono,live/split'
    grep -q "^migration split-moved: every root plans with no change against its new state" "$work/waits.log" || { log "wave 1 did not prove the migration on the units"; rc=1; }
    [ "$AUDIT_CODE" = 3 ] || { log "wave 1 exited $AUDIT_CODE, not 3: it did not wait for the migration"; rc=1; }
    digest="$(sed -n 's/^migration split-moved waits for an approval of digest \([^ ]*\)\. .*/\1/p' "$work/waits.log")"
    [ -n "$digest" ] || { log "wave 1 printed no digest to approve"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    migrate_approve "$work/origin.git" "$work/ledger" smoke-approver split-moved "$digest" || { log "could not approve the migration"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    curl -fsS "$FLOCI/$bucket/live/mono/terraform.tfstate" -o "$work/mono.body" && curl -fsS -o /dev/null -X PUT --data-binary @"$work/mono.body" "$FLOCI/$bucket/live/mono/terraform.tfstate" \
      || { log "could not write live/mono's state again"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    tg_migrate_wave "$work" applies 'live/mono,live/split'
    [ "$AUDIT_CODE" = 4 ] && grep -q "the states moved since: live/mono" "$work/applies.log" && log "wave 1 refused: live/mono's state moved since the approval"
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE after the approval, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "^migration split-moved applied$" "$work/applies.log" || { log "the log does not say the migration applied"; rc=1; }
    grep -q "^wave 1 of 1: set digest .*, 0 changes, 0 destroys$\|^wave 1 of 1: no changes$" "$work/applies.log" || { log "the wave after the migration planned changes"; rc=1; }
    mono="$(curl -fsS "$FLOCI/$bucket/live/mono/terraform.tfstate" | jq -r '[.resources[].name] | join(",")')"
    split="$(curl -fsS "$FLOCI/$bucket/live/split/terraform.tfstate" | jq -r '[.resources[].name] | join(",")')"
    [ "$mono" = keep ] && [ "$split" = moved ] || { log "live/mono holds [$mono] and live/split [$split], not keep and moved"; rc=1; }
    record="$(cat "$work/wave/terragucci-report/migrations/split-moved.json" 2>/dev/null)" || { log "no migration record in terragucci-report/"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -c '{status, digest, roots: [.roots[] | {root, location, before, after: .after.version_id}]}' <<<"$record" >&2
    [ "$(jq -r .status <<<"$record")" = applied ] || { log "the record says $(jq -r .status <<<"$record"), not applied"; rc=1; }
    for v in mono split; do
      [ "$(jq -r --arg r "live/$v" '.roots[] | select(.root == $r) | .location' <<<"$record")" = "s3://$bucket/live/$v/terraform.tfstate" ] || { log "the record does not place live/$v's state at its remote_state key"; rc=1; }
      [ "$(jq -r --arg r "live/$v" '.roots[] | select(.root == $r) | .after.version_id' <<<"$record")" = "$(curl -fsS -o /dev/null -D - "$FLOCI/$bucket/live/$v/terraform.tfstate" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }')" ] \
        || { log "the version recorded after for live/$v is not its state's current one"; rc=1; }
    done
    keys="$(curl -fsS "$FLOCI/$bucket?list-type=2" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' | tr '\n' ' ')"
    case "$keys" in *.tflock*) log "a lock file is left: $keys"; rc=1 ;; esac
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "live/mono split into two units with no change, approved by digest, written under lock, versions before and after recorded"
  return $rc
}

claim_init/terragrunt_root_pins() {
  # Three Terragrunt units in one wave: live/old pins OpenTofu 1.10.6 in its
  # .opentofu-version, live/older pins Terragrunt 1.1.5 with an exact
  # terragrunt_version_constraint (Terragrunt itself refuses to run the unit
  # under any other release), and live/new pins nothing. tf-plan --terragrunt,
  # run in the Terragrunt image as the plan job runs it, installs both,
  # checked against their SHA256SUMS, and plans each unit with its own
  # releases in one run --all per pair. live/old's plan.json says tofu
  # 1.10.6, live/new's the image's tofu, live/older plans at all, and the
  # report names each unit's binary and Terragrunt release with the pin.
  # BREAK: the pins are written where the stage does not read them (the
  # .opentofu-version in the module, the constraint commented out), so every
  # unit plans with the image's releases.
  log() { echo "[smoke tg-root-pins] $*" >&2; }
  local work rc=0 image dir r carried old new u
  image="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/repo"
  : > "$work/repo/root.hcl"
  for u in old older new; do
    mkdir -p "$work/repo/live/$u"
    printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n' > "$work/repo/live/$u/terragrunt.hcl"
    printf 'resource "terraform_data" "%s" {\n  input = "%s"\n}\n' "$u" "$u" > "$work/repo/live/$u/main.tf"
  done
  if [ -n "${BREAK:-}" ]; then
    mkdir -p "$work/repo/modules/old" && echo 1.10.6 > "$work/repo/modules/old/.opentofu-version"
    printf '\n# terragrunt_version_constraint = "= 1.1.5"\n' >> "$work/repo/live/older/terragrunt.hcl"
  else
    echo 1.10.6 > "$work/repo/live/old/.opentofu-version"
    printf '\nterragrunt_version_constraint = "= 1.1.5"\n' >> "$work/repo/live/older/terragrunt.hcl"
  fi
  printf 'binary: tofu\n' > "$work/repo/terragucci.yml"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "three units, three pairs of releases"
  tg_in_image "$work/repo" -e TG_TF_PATH=tofu -e TOFU_INSTALL_DIR=/cache/bin -- terragucci stage tf-plan --terragrunt --binary tofu --layers 'live/new,live/old,live/older' >"$work/plan.log" 2>&1 || log "the plan run exited non-zero"
  cat "$work/plan.log" >&2
  clean_mounted "$work/repo" "$image"
  dir="$work/repo/terragucci-report"
  [ -f "$dir/report.json" ] || { log "the plan wrote no report"; drop_work "$work"; return 1; }
  jq -c '.roots[] | {path, status, binary}' "$dir/report.json" >&2
  [ "$(jq -c '[.waves[] | .roots | sort]' "$dir/report.json")" = '[["live/new","live/old","live/older"]]' ] || { log "the three units are not one planned wave: $(jq -c '[.waves[].roots]' "$dir/report.json")"; rc=1; }
  old="$(jq -r '.terraform_version // ""' "$dir/roots/live/old/plan.json" 2>/dev/null)"
  new="$(jq -r '.terraform_version // ""' "$dir/roots/live/new/plan.json" 2>/dev/null)"
  carried="$(jq -r '.roots[] | select(.path == "live/new") | .binary.version // ""' "$dir/report.json")"
  log "live/old planned with tofu ${old:-?}, live/new with tofu ${new:-?}; the image carries ${carried:-?}"
  [ "$old" = 1.10.6 ] || { log "live/old did not plan with the tofu 1.10.6 its .opentofu-version pins"; rc=1; }
  [ -n "$new" ] && [ "$new" = "$carried" ] && [ "$new" != 1.10.6 ] || { log "live/new did not plan with the image's tofu"; rc=1; }
  [ "$(jq -r '.roots[] | select(.path == "live/older") | .status' "$dir/report.json")" = planned ] || { log "live/older did not plan: $(jq -r '.roots[] | select(.path == "live/older") | .error // ""' "$dir/report.json")"; rc=1; }
  [ "$(jq -c '.roots[] | select(.path == "live/old") | .binary | {name, version, pin}' "$dir/report.json")" = '{"name":"tofu","version":"1.10.6","pin":".opentofu-version"}' ] \
    || { log "the report does not name live/old's binary as tofu 1.10.6 pinned by .opentofu-version"; rc=1; }
  [ "$(jq -c '.roots[] | select(.path == "live/older") | .binary.terragrunt' "$dir/report.json")" = '{"version":"1.1.5","pin":"terragrunt_version_constraint"}' ] \
    || { log "the report does not name live/older's Terragrunt as 1.1.5 pinned by terragrunt_version_constraint"; rc=1; }
  grep -qF 'live/older: tofu '"$carried"' under Terragrunt 1.1.5 (terragrunt_version_constraint)' "$work/plan.log" || { log "the log does not say live/older runs under Terragrunt 1.1.5"; rc=1; }
  grep -qF 'live/old: tofu 1.10.6 (.opentofu-version)' "$work/plan.log" || { log "the log does not say live/old runs tofu 1.10.6"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "one wave planned live/old with tofu 1.10.6 and live/older under Terragrunt 1.1.5, each installed and checked in the job, and live/new with the image's releases"
  return $rc
}

claim_binary/terragrunt_choudoufu() {
  # A Terragrunt repo of two units with binary: choudoufu. init writes a
  # pipeline whose jobs run in the choudoufu image, install Terragrunt beside
  # it, and set TG_TF_PATH to choudoufu. The plan job's install step and its
  # tf-plan --terragrunt, run in the choudoufu image as the job runs them,
  # plan both units with choudoufu: each unit's plan.json carries the OpenTofu
  # version choudoufu reports, and the report names choudoufu as each unit's
  # binary.
  # BREAK: the plan runs as Terragrunt repos ran before choudoufu worked under
  # Terragrunt, in the Terragrunt image with tofu, so no plan is choudoufu's.
  log() { echo "[smoke tg-choudoufu] $*" >&2; }
  local work rc=0 cimage wf install want dir u got bin=choudoufu
  cimage="$(image_tag choudoufu)"
  docker image inspect "$cimage" >/dev/null 2>&1 || { log "no CI image $cimage; run 'just images' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/repo"
  : > "$work/repo/root.hcl"
  for u in a b; do
    mkdir -p "$work/repo/live/$u"
    printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n' > "$work/repo/live/$u/terragrunt.hcl"
    printf 'resource "terraform_data" "%s" {\n  input = "%s"\n}\n' "$u" "$u" > "$work/repo/live/$u/main.tf"
  done
  printf 'forge: forgejo\nbinary: choudoufu\n' > "$work/repo/terragucci.yml"
  git -C "$work/repo" init -q -b main
  (cd "$work/repo" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/repo/.forgejo/workflows/terragucci.yml"
  grep -q 'terragucci-choudoufu:' "$wf" || { log "the pipeline does not run in the choudoufu image"; rc=1; }
  grep -q 'TG_TF_PATH: choudoufu' "$wf" || { log "the pipeline does not set TG_TF_PATH to choudoufu"; rc=1; }
  install="$(grep -o 'dir="$(terragucci install terragrunt [0-9.]*)"' "$wf" | head -1)"
  [ -n "$install" ] || { log "the pipeline installs no Terragrunt"; rc=1; }
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "two units, choudoufu"
  want="$(docker run --rm --entrypoint choudoufu "$cimage" version -json | jq -r .terraform_version)"
  if [ $rc = 0 ]; then
    if [ -n "${BREAK:-}" ]; then
      bin=tofu
      tg_in_image "$work/repo" -e TG_TF_PATH=tofu -- terragucci stage tf-plan --terragrunt --binary tofu --layers 'live/a,live/b' >"$work/plan.log" 2>&1 || log "the plan run exited non-zero"
    else
      # The job's install step, then its plan step with the path the step added.
      # shellcheck disable=SC2016 # expanded by the container's shell
      TG_IN_IMAGE="$cimage" tg_in_image "$work/repo" -e TG_TF_PATH=choudoufu -e TOFU_INSTALL_DIR=/cache/bin -- \
        sh -c "$install"' && export PATH="$dir:$PATH" && terragucci stage tf-plan --terragrunt --binary choudoufu --layers "live/a,live/b"' >"$work/plan.log" 2>&1 || log "the plan run exited non-zero"
    fi
    cat "$work/plan.log" >&2
    clean_mounted "$work/repo" "$cimage"
    dir="$work/repo/terragucci-report"
    if [ ! -f "$dir/report.json" ]; then
      log "the plan wrote no report"; rc=1
    else
      for u in a b; do
        got="$(jq -r '.terraform_version // ""' "$dir/roots/live/$u/plan.json" 2>/dev/null)"
        [ "$(jq -r --arg p "live/$u" '.roots[] | select(.path == $p) | .status' "$dir/report.json")" = planned ] || { log "live/$u did not plan"; rc=1; }
        [ "$got" = "$want" ] || { log "live/$u's plan was made by OpenTofu ${got:-?}, not the $want choudoufu reports"; rc=1; }
        [ "$(jq -r --arg p "live/$u" '.roots[] | select(.path == $p) | .binary.name' "$dir/report.json")" = choudoufu ] || { log "the report names $bin, not choudoufu, as live/$u's binary"; rc=1; }
      done
    fi
  fi
  drop_work "$work" "$cimage"
  [ $rc = 0 ] && log "both units planned with choudoufu through TG_TF_PATH, in the choudoufu image with Terragrunt installed beside it"
  return $rc
}

claim_waves/terragrunt_stack() {
  # A Terragrunt repo whose only units come from an explicit stack:
  # live/stk/terragrunt.stack.hcl generates base and top from catalog
  # templates, and top reads base's output. init, run in the Terragrunt
  # image, generates the stack and writes a pipeline of two waves, base then
  # top, under live/stk/.terragrunt-stack/. From a fresh clone, where nothing
  # is generated (.terragrunt-stack is ignored), tf-apply --terragrunt waves 1
  # and 2 generate the stack before discovery and apply base, then top on
  # base's real output: both units' states are in floci and top's holds the
  # value base wrote.
  # BREAK: terragrunt stack generate does nothing (a wrapper stands in for
  # it), so discovery finds none of the stack's units and init writes no
  # waves. (A wave's run --all generates the stack again on its own, so the
  # claim's waves still run on the layers the plain run's init wrote.)
  log() { echo "[smoke tg-stacks] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 image prefix="tg-stacks-$STAMP" layers w code base top tg=terragrunt
  image="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/repo/live/stk" "$work/repo/catalog/units/base" "$work/repo/catalog/units/top" "$work/repo/modules/rev" "$work/bin"
  printf 'remote_state {\n  backend      = "s3"\n  disable_init = true\n  generate = {\n    path      = "backend.tf"\n    if_exists = "overwrite_terragrunt"\n  }\n  config = {\n    bucket         = "shop-terraform-state"\n    key            = "%s/${path_relative_to_include()}/terraform.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n' "$prefix" > "$work/repo/root.hcl"
  printf 'variable "rev" {\n  type = string\n}\n\nresource "terraform_data" "this" {\n  input = var.rev\n}\n\noutput "rev" {\n  value = terraform_data.this.output\n}\n' > "$work/repo/modules/rev/main.tf"
  printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "${get_repo_root()}/modules/rev"\n}\n\ninputs = {\n  rev = values.rev\n}\n' > "$work/repo/catalog/units/base/terragrunt.hcl"
  printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "${get_repo_root()}/modules/rev"\n}\n\ndependency "base" {\n  config_path = "../base"\n}\n\ninputs = {\n  rev = "on-${dependency.base.outputs.rev}"\n}\n' > "$work/repo/catalog/units/top/terragrunt.hcl"
  printf 'unit "base" {\n  source = "${get_repo_root()}/catalog/units/base"\n  path   = "base"\n  values = {\n    rev = "stk-%s"\n  }\n}\n\nunit "top" {\n  source = "${get_repo_root()}/catalog/units/top"\n  path   = "top"\n}\n' "$STAMP" > "$work/repo/live/stk/terragrunt.stack.hcl"
  printf 'forge: forgejo\nbinary: tofu\ngate: never\n' > "$work/repo/terragucci.yml"
  printf '.terragrunt-stack/\n.terragrunt-cache/\nterragucci-report/\n' > "$work/repo/.gitignore"
  git -C "$work/repo" init -q -b main
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "an explicit stack"
  # The stand-in that generates nothing, for BREAK.
  printf '#!/bin/sh\n[ "$1" = stack ] && exit 0\nexec terragrunt "$@"\n' > "$work/bin/terragrunt-nogen"
  chmod +x "$work/bin/terragrunt-nogen"
  [ -n "${BREAK:-}" ] && tg=/smoke/terragrunt-nogen
  tg_in_image "$work/repo" -v "$work/bin:/smoke:ro" -e TG_TF_PATH=tofu -e "TERRAGUCCI_TERRAGRUNT=$tg" -- terragucci init >"$work/init.log" 2>&1 || log "init exited non-zero"
  cat "$work/init.log" >&2
  clean_mounted "$work/repo" "$image"
  layers="$(grep -o "tf-apply --wave 1 --layers '[^']*'" "$work/repo/.forgejo/workflows/terragucci.yml" 2>/dev/null | head -1 | sed "s/.*--layers '//; s/'$//")"
  [ "$layers" = "live/stk/.terragrunt-stack/base;live/stk/.terragrunt-stack/top" ] || { log "the pipeline's waves are [$layers], not base then top"; rc=1; }
  grep -q 'terragrunt stack generate' "$work/repo/.forgejo/workflows/terragucci.yml" 2>/dev/null || { log "the check job does not generate the stack"; rc=1; }
  [ -n "${BREAK:-}" ] && layers="live/stk/.terragrunt-stack/base;live/stk/.terragrunt-stack/top"
  if [ -n "$layers" ] && { [ $rc = 0 ] || [ -n "${BREAK:-}" ]; }; then
    git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "the pipeline" >/dev/null 2>&1 || true
    git clone -q "$work/repo" "$work/fresh"
    for w in 1 2; do
      code=0
      tg_in_image "$work/fresh" -v "$work/bin:/smoke:ro" -e TG_TF_PATH=tofu -e "TERRAGUCCI_TERRAGRUNT=$tg" -- \
        terragucci stage tf-apply --wave "$w" --layers "$layers" --binary tofu --gate never --terragrunt >"$work/wave-$w.log" 2>&1 || code=$?
      cat "$work/wave-$w.log" >&2
      clean_mounted "$work/fresh" "$image"
      [ "$code" = 0 ] || { log "wave $w exited $code, not 0"; rc=1; break; }
    done
  fi
  base="$(curl -fsS "$FLOCI/shop-terraform-state/$prefix/live/stk/.terragrunt-stack/base/terraform.tfstate" 2>/dev/null | jq -r '[.resources[] | .instances[].attributes.output | if type == "object" then .value else . end] | join(",")' 2>/dev/null)"
  top="$(curl -fsS "$FLOCI/shop-terraform-state/$prefix/live/stk/.terragrunt-stack/top/terraform.tfstate" 2>/dev/null | jq -r '[.resources[] | .instances[].attributes.output | if type == "object" then .value else . end] | join(",")' 2>/dev/null)"
  log "base's state holds [${base:-}], top's [${top:-}]"
  [ "$base" = "stk-$STAMP" ] || { log "base did not apply stk-$STAMP"; rc=1; }
  [ "$top" = "on-stk-$STAMP" ] || { log "top did not apply on base's real output"; rc=1; }
  for w in base top; do curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$prefix/live/stk/.terragrunt-stack/$w/terraform.tfstate" || true; done
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the stack's units were generated before discovery, cut into two waves, and applied base then top on base's real output"
  return $rc
}

# ── explicit stacks ───────────────────────────────────────────────────────
# stack/fixtures/tg-stack: live/stk/terragrunt.stack.hcl generates base and
# top from catalog/units, each taking its rev from the stack's values, and
# top reads base's output, so base is wave 1 and top wave 2. gate: always.
# Its state is in floci under @PREFIX@.

tg_stack_tree() { # dir, prefix -> the fixture in dir, committed on main
  mkdir -p "$1"
  cp -R "$HERE/fixtures/tg-stack/." "$1/"
  perl -pi -e "s#\@PREFIX\@#$2#" "$1/root.hcl"
  git -C "$1" init -q -b main
  git -C "$1" add -A && git -C "$1" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "an explicit stack"
}

tg_stack_rev() { # dir, unit, rev -> the stack file feeds that unit the rev
  perl -0pi -e "s/(unit \"$2\" \\{.*?rev = \")[^\"]*\"/\${1}$3\"/s" "$1/live/stk/terragrunt.stack.hcl"
}

claim_check/terragrunt_stack() {
  # The stack file stops feeding top the rev its template reads
  # (values.rev). Pushed to a branch, the check job generates the stack and
  # terragrunt hcl validate fails on the generated top unit, naming it and
  # the rev it lacks.
  # BREAK: the pushed pipeline's check job does not generate the stack, so
  # validate never sees the stack's units.
  log() { echo "[smoke tg-stack-check] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-stack-check" sha logs rc=0 wf
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  GATED_INIT_TG=1 gated_repo tg-stack-check tg-stack || { drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q "terragrunt stack generate" "$wf" || { log "init wrote no stack generate into the check job"; rc=1; }
  [ -n "${BREAK:-}" ] && perl -ni -e 'print unless /terragrunt stack generate/' "$wf"
  perl -0pi -e 's/(unit "top" \{.*?values = \{\n)    rev = "1"\n/${1}    note = "no rev"\n/s' "$work/tree/live/stk/terragrunt.stack.hcl"
  sha="$(push_tree "$work/tree" "$repo" smoke/check "tg-stack-check: the stack file feeds top no rev")"
  wait_run "$repo" "$sha"
  logs="$(run_logs "$repo" "$RUN_ID")"
  log "the push ended '$RUN_STATUS'"
  [ "$RUN_STATUS" = failure ] || { log "the check did not fail"; rc=1; }
  grep -q "\.terragrunt-stack/top" <<<"$logs" || { log "the log does not name the generated top unit"; rc=1; }
  grep -q 'attribute named "rev"' <<<"$logs" || { log "the log does not name the rev top lacks"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the check job generated the stack and failed on live/stk/.terragrunt-stack/top, which the stack file feeds no rev"
  return $rc
}

claim_affected/terragrunt_stack() {
  # The base is the fixture; the head changes base's rev in the stack file
  # and nothing else. tf-plan against the base, in the Terragrunt image,
  # plans live/stk/.terragrunt-stack/base alone, selected for the stack
  # file, lists top as waiting on it because it depends on a changed unit,
  # and the report and note name live/stk/terragrunt.stack.hcl.
  # BREAK: no base, so every unit is planned for no reason of its own.
  log() { echo "[smoke tg-stack-affected] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 base r b="live/stk/.terragrunt-stack/base" t="live/stk/.terragrunt-stack/top" image
  image="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_stack_tree "$work/repo" "tg-stack-affected-$STAMP"
  base="$(git -C "$work/repo" rev-parse HEAD)"
  tg_stack_rev "$work/repo" base 2
  git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "base takes rev 2"
  [ -n "${BREAK:-}" ] && base=""
  tg_in_image "$work/repo" -e TG_TF_PATH=tofu -e "TG_BASE=$base" -- terragucci stage tf-plan --terragrunt --binary tofu >"$work/plan.log" 2>&1 || true
  cat "$work/plan.log" >&2
  clean_mounted "$work/repo" "$image"
  r="$work/repo/terragucci-report/report.json"
  if [ ! -f "$r" ]; then log "no report"; rc=1
  else
    jq -c '[.roots[] | {path, status, selection: .terragrunt.selection, stack: .terragrunt.stack, stack_file: .terragrunt.stack_file}], .deferred' "$r" >&2
    [ "$(jq -r '[.roots[] | select(.terragrunt.provisional | not) | .path] | join(",")' "$r")" = "$b" ] || { log "the plan covers more or less than $b"; rc=1; }
    jq -e --arg b "$b" '.roots[] | select(.path == $b) | .terragrunt.selection | contains("live/stk/terragrunt.stack.hcl")' "$r" >/dev/null || { log "$b's selection does not name the stack file"; rc=1; }
    jq -e --arg b "$b" '.roots[] | select(.path == $b) | .terragrunt.stack == "live/stk" and .terragrunt.stack_file == "live/stk/terragrunt.stack.hcl"' "$r" >/dev/null || { log "the report does not name $b's stack and stack file"; rc=1; }
    jq -e --arg t "$t" --arg b "$b" '[.deferred[]? | select(.unit == $t and .after == [$b] and .why == "depends on a changed unit")] | length == 1' "$r" >/dev/null || { log "$t is not listed as waiting on $b"; rc=1; }
    grep -q 'Explicit stacks: `live/stk/terragrunt.stack.hcl` generates `base`' "$work/repo/terragucci-report/note.md" || { log "the note does not name the stack file"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "a change to base's value in the stack file planned base alone, top waits on it, and the report and note name the stack file"
  return $rc
}

claim_drift/terragrunt_stack() {
  # The fixture plus a third unit, queue, which the stack generates from
  # catalog/units/queue: one SQS queue on floci. Every unit is applied in the
  # Terragrunt image, then the queue is deleted outside Terraform. From a
  # fresh clone, where nothing is generated, tf-drift generates the stack and
  # reports aws_sqs_queue.this deleted under live/stk/.terragrunt-stack/queue
  # and nothing else deleted, and the report names the unit's stack file.
  # BREAK: terragrunt stack generate does nothing (a wrapper stands in for
  # it), so the fresh clone has no unit to check.
  log() { echo "[smoke tg-stack-drift] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work rc=0 image prefix="tg-stack-drift-$STAMP" queue="tgstk-drift-$STAMP" url r deletes tg=terragrunt q="live/stk/.terragrunt-stack/queue" k
  image="$(tg_image)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tg_stack_tree "$work/repo" "$prefix"
  mkdir -p "$work/repo/modules/queue" "$work/repo/catalog/units/queue" "$work/bin"
  printf 'variable "name" {\n  type = string\n}\n\nresource "aws_sqs_queue" "this" {\n  name = var.name\n}\n' > "$work/repo/modules/queue/main.tf"
  printf 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\nterraform {\n  source = "${get_repo_root()}/modules/queue"\n}\n\ngenerate "provider" {\n  path      = "provider.tf"\n  if_exists = "overwrite_terragrunt"\n  contents  = "provider \\"aws\\" {\\n  region = \\"us-east-1\\"\\n}\\n"\n}\n\ninputs = {\n  name = values.name\n}\n' > "$work/repo/catalog/units/queue/terragrunt.hcl"
  printf '\nunit "queue" {\n  source = "${get_repo_root()}/catalog/units/queue"\n  path   = "queue"\n\n  values = {\n    name = "%s"\n  }\n}\n' "$queue" >> "$work/repo/live/stk/terragrunt.stack.hcl"
  git -C "$work/repo" add -A && git -C "$work/repo" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "a queue unit"
  tg_in_image "$work/repo" -e TG_TF_PATH=tofu -- sh -c 'terragrunt stack generate --non-interactive --no-color && terragrunt run --all --non-interactive --no-color --filter "!./catalog/**" -- apply -auto-approve -input=false -no-color' >"$work/apply.log" 2>&1 \
    || { cat "$work/apply.log" >&2; log "the stack did not apply"; rc=1; }
  clean_mounted "$work/repo" "$image"
  url="$(curl -fsS -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.GetQueueUrl' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')" || url=""
  [ -n "$url" ] || { log "$queue is not in floci after the apply"; rc=1; }
  if [ $rc = 0 ]; then
    curl -fsS -o /dev/null -X POST "$FLOCI/" -H 'X-Amz-Target: AmazonSQS.DeleteQueue' -H 'Content-Type: application/x-amz-json-1.0' -d "{\"QueueUrl\":\"$url\"}" || rc=1
    printf '#!/bin/sh\n[ "$1" = stack ] && exit 0\nexec terragrunt "$@"\n' > "$work/bin/terragrunt-nogen"
    chmod +x "$work/bin/terragrunt-nogen"
    [ -n "${BREAK:-}" ] && tg=/smoke/terragrunt-nogen
    git clone -q "$work/repo" "$work/fresh"
    tg_in_image "$work/fresh" -v "$work/bin:/smoke:ro" -e TG_TF_PATH=tofu -e "TERRAGUCCI_TERRAGRUNT=$tg" -- terragucci stage tf-drift --terragrunt --binary tofu >"$work/drift.log" 2>&1 || true
    cat "$work/drift.log" >&2
    clean_mounted "$work/fresh" "$image"
    r="$work/fresh/terragucci-report/report.json"
    if [ ! -f "$r" ]; then log "the drift run wrote no report"; rc=1
    else
      deletes="$(jq -r '[.roots[] | .path as $p | .changes[] | select(.action == "delete") | "\($p) \(.address)"] | join(",")' "$r")"
      [ "$deletes" = "$q aws_sqs_queue.this" ] || { log "the deletes are not exactly $q's queue: ${deletes:-none}"; rc=1; }
      jq -e --arg q "$q" '.roots[] | select(.path == $q) | .terragrunt.stack_file == "live/stk/terragrunt.stack.hcl"' "$r" >/dev/null || { log "the report does not name $q's stack file"; rc=1; }
    fi
  fi
  for k in base top queue; do curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$prefix/live/stk/.terragrunt-stack/$k/terraform.tfstate" || true; done
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "tf-drift generated the stack in a fresh clone, reported $q's queue deleted, and named live/stk/terragrunt.stack.hcl"
  return $rc
}

# ── state access per environment, state export, cross-state edges ─────────
state_in() { # work, command... -> as audit_in, with the docker arguments in STATE_IN_EXTRA, in the STATE_IN_IMAGE image (tofu)
  local work="$1" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"; shift
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/wave:/repo" -v "$work/origin.git:/origin.git" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    ${STATE_IN_EXTRA[@]+"${STATE_IN_EXTRA[@]}"} "$(image_tag "${STATE_IN_IMAGE:-tofu}")" "$@"
}

state_roles_root() { # work, state bucket, env, [env whose state it reads]
  local work="$1" bucket="$2" env="$3" reads="${4:-}"
  mkdir -p "$work/wave/envs/$env/app"
  {
    printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "%s/app.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$bucket" "$env" "$env"
    [ -z "$reads" ] || printf '\ndata "terraform_remote_state" "up" {\n  backend = "s3"\n  config = {\n    bucket         = "%s"\n    key            = "%s/app.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n' "$bucket" "$reads"
  } > "$work/wave/envs/$env/app/main.tf"
}

claim_oidc/state_roles() {
  # Two environments, envs/dev/app and envs/prod/app, each with its state
  # under its own key of one floci bucket, and oidc.roles giving each glob a
  # plan and an apply role. config check lists each role with its roots and
  # state key and warns about nothing. init writes the apply job's roles by
  # glob (TERRAGUCCI_ROOT_ROLES), and one tf-apply wave over both roots, with
  # the job's static keys and a stand-in OIDC token floci's STS answers, gives
  # each root its own environment's apply role: a step before plan prints
  # AWS_ROLE_ARN per root, and each root's state version is read with it.
  # Then prod's app reads dev's state through terraform_remote_state, and
  # config check warns that prod's roles reach dev's state, exiting 0.
  # floci grants every role, so the claim shows which role each root runs as,
  # not that IAM refuses another environment's key.
  # BREAK: prod's apply role is dev's, so config check warns that one role is
  # two environments' and prod's app applies as dev-apply.
  log() { echo "[smoke state-roles] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 bucket="tgsr-$STAMP" out roles line env acct="arn:aws:iam::000000000000:role"
  local prod_apply="$acct/prod-apply"
  [ -n "${BREAK:-}" ] && prod_apply="$acct/dev-apply"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  state_roles_root "$work" "$bucket" dev
  state_roles_root "$work" "$bucket" prod
  cat > "$work/wave/terragucci.yml" <<YML
forge: forgejo
binary: tofu
oidc:
  roles:
    "envs/dev/**": { plan: $acct/dev-plan, apply: $acct/dev-apply }
    "envs/prod/**": { plan: $acct/prod-plan, apply: $prod_apply }
steps:
  - name: role
    run: echo "role-check \$TG_ROOT \$AWS_ROLE_ARN"
    before: plan
YML
  (cd "$work/wave" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  audit_origin "$work"
  # config check: each role's roots and state key, and no warning.
  out="$(cd "$work/wave" && "$TERRAGUCCI" config check --json 2>/dev/null)" || { log "config check exited $?"; rc=1; }
  jq -c '.results | {warnings, state_access: [.state_access[]? | {role, stage, environment, roots, states}]}' <<<"$out" >&2
  [ "$(jq -r '.results.warnings // [] | length' <<<"$out")" = 0 ] || { log "config check warns: $(jq -c '.results.warnings' <<<"$out")"; rc=1; }
  jq -e --arg b "$bucket" --arg r "$acct/prod-apply" '[.results.state_access[] | select(.role == $r and .stage == "apply")] == [{role: $r, stage: "apply", environment: "envs/prod/**", roots: ["envs/prod/app"], states: ["s3://" + $b + "/prod/app.tfstate"], reads: []}]' <<<"$out" >/dev/null \
    || { log "config check does not list prod-apply with envs/prod/app and its state key alone"; rc=1; }
  # The apply job's roles by glob, as init wrote them.
  line="$(grep -o "export TERRAGUCCI_ROOT_ROLES='[^']*dev-apply[^']*'" "$work/wave/.forgejo/workflows/terragucci.yml" | head -1)"
  roles="${line#export TERRAGUCCI_ROOT_ROLES=\'}"; roles="${roles%\'}"
  [ -n "$roles" ] || { log "the apply job carries no TERRAGUCCI_ROOT_ROLES"; rc=1; }
  grep -q "export TERRAGUCCI_ROOT_ROLES='[^']*dev-plan" "$work/wave/.forgejo/workflows/terragucci.yml" || { log "the plan job carries no plan roles"; rc=1; }
  if [ $rc = 0 ]; then
    # A token shaped like the forge's, with the claims floci's STS reads; it answers with keys of its own.
    node -e 'const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");const t=Math.floor(Date.now()/1000);process.stdout.write(b({alg:"RS256",typ:"JWT"})+"."+b({iss:"https://token.actions.githubusercontent.com",sub:"repo:smoke/roles:ref:refs/heads/main",aud:"sts.amazonaws.com",iat:t,nbf:t,exp:t+3600})+".c21va2U")' > "$work/wave/.oidc-token"
    AUDIT_CODE=0
    # The s3 backend asks STS for the role at AWS_ENDPOINT_URL_STS, which AWS_ENDPOINT_URL does not set for it.
    STATE_IN_EXTRA=(-e "TERRAGUCCI_ROOT_ROLES=$roles" -e AWS_WEB_IDENTITY_TOKEN_FILE=/repo/.oidc-token -e AWS_ROLE_SESSION_NAME=smoke -e AWS_ENDPOINT_URL_STS=http://floci:4566)
    state_in "$work" terragucci stage tf-apply --wave 1 --layers 'envs/dev/app,envs/prod/app' --binary tofu --gate never --base HEAD > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    STATE_IN_EXTRA=()
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "the wave exited $AUDIT_CODE, not 0"; rc=1; }
    grep -q "role-check envs/dev/app $acct/dev-apply\$" "$work/run.log" || { log "envs/dev/app did not run as dev-apply"; rc=1; }
    grep -q "role-check envs/prod/app $acct/prod-apply\$" "$work/run.log" || { log "envs/prod/app did not run as prod-apply"; rc=1; }
    for env in dev prod; do
      grep -q "^envs/$env/app: state s3://$bucket/$env/app.tfstate" "$work/run.log" || { log "envs/$env/app printed no state line"; rc=1; }
    done
    [ "$(curl -fsS -o /dev/null -w '%{http_code}' "$FLOCI/$bucket/prod/app.tfstate")" = 200 ] || { log "prod's state is not at its key"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # prod's app reads dev's state: its roles reach another environment's state.
    state_roles_root "$work" "$bucket" prod dev
    out="$(cd "$work/wave" && "$TERRAGUCCI" config check --json 2>/dev/null)" || { log "config check with the read exited $?"; rc=1; }
    jq -c '.results.warnings' <<<"$out" >&2
    jq -e --arg b "$bucket" '[.results.warnings[]? | select(startswith("oidc: envs/prod/app (envs/prod/**) reads the state of envs/dev/app (envs/dev/**)") and contains("s3://" + $b + "/dev/app.tfstate, another environment'"'"'s state"))] | length == 1' <<<"$out" >/dev/null \
      || { log "config check does not warn that prod's roles reach dev's state"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "each environment's root ran as its own apply role, config check listed each role's state key, and it warned when prod read dev's state"
  return $rc
}

claim_state/export() {
  # state_versions_repo's root applies twice into a versioned floci bucket.
  # In the CI image, as a person at a shell would: terragucci state export
  # app --version <the first> --actor alice records a request on
  # chant/lifecycle and exits 3 with the terragucci approve command. bob runs that
  # command in a clone. The same export then writes the version to /out,
  # mode 0600, byte for byte the version floci holds, and done.jsonl names
  # alice, app, the version and bob. terragucci audit lists a state-export
  # entry with who alice and what app. The export adds no object under the
  # reports prefix but the audit trail's, none of which holds an input value,
  # and no object there holds the state's lineage.
  # BREAK: alice approves her own request, which does not count, so the
  # second export waits again and writes nothing.
  log() { echo "[smoke state-export] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="export-$STAMP" bucket="tgse-$STAMP" n v1="" v2="" digest code clone approver=bob done audit lineage key keys after added
  [ -n "${BREAK:-}" ] && approver=alice
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/out"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket?versioning" -H 'content-type: application/xml' \
    --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
    || { log "could not turn on versioning for $bucket"; return 1; }
  state_versions_repo "$work" "$prefix" "$bucket" "se-$STAMP-1"
  for n in 1 2; do
    [ $rc = 0 ] || break
    if [ $n = 2 ]; then
      state_versions_root "$work" "$bucket" "se-$STAMP-2"
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "app input 2"
    fi
    AUDIT_CODE=0
    audit_in "$work" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { cat "$work/run.log" >&2; log "apply $n exited $AUDIT_CODE, not 0"; rc=1; }
    [ $n = 1 ] && v1="$(curl -fsS -o /dev/null -D - "$FLOCI/$bucket/app.tfstate" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }')"
    [ $n = 2 ] && v2="$(curl -fsS -o /dev/null -D - "$FLOCI/$bucket/app.tfstate" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }')"
  done
  [ $rc = 0 ] && { [ -n "$v1" ] && [ -n "$v2" ] && [ "$v1" != "$v2" ] || { log "the bucket holds no two versions of app.tfstate ($v1, $v2)"; rc=1; }; }
  # The reports prefix before any export: an export adds no object to it but the audit trail's.
  keys="$(curl -fsS "$FLOCI/$REPORT_BUCKET?list-type=2&prefix=$prefix/" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' | sort)"
  if [ $rc = 0 ]; then
    code=0
    STATE_IN_EXTRA=(-v "$work/out:/out")
    state_in "$work" terragucci state export app --version "$v1" --actor alice > "$work/ask.log" 2>&1 || code=$?
    cat "$work/ask.log" >&2
    [ "$code" = 3 ] || { log "the request exited $code, not 3"; rc=1; }
    digest="$(grep -o 'terragucci approve export app --plan sha256:[0-9a-f]*' "$work/ask.log" | head -1 | awk '{print $NF}')"
    [ -n "$digest" ] || { log "the request printed no terragucci approve command"; rc=1; }
    [ -z "$(ls -A "$work/out")" ] || { log "the request wrote a file before any approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    clone="$work/approver"
    git clone -q "$work/origin.git" "$clone"
    (cd "$clone" && GIT_AUTHOR_NAME="$approver" GIT_AUTHOR_EMAIL="$approver@localhost" GIT_COMMITTER_NAME="$approver" GIT_COMMITTER_EMAIL="$approver@localhost" \
      "$TERRAGUCCI" approve export app --plan "$digest" --actor "$approver") >&2 || { log "$approver could not approve the request"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    code=0
    # shellcheck disable=SC2016 # expanded by the container's shell
    state_in "$work" sh -c 'terragucci state export app --version "$0" --actor alice --out /out/app.tfstate && stat -c "mode %a" /out/app.tfstate' "$v1" > "$work/get.log" 2>&1 || code=$?
    STATE_IN_EXTRA=()
    cat "$work/get.log" >&2
    [ "$code" = 0 ] || { log "the export after $approver's approval exited $code, not 0"; rc=1; }
    [ -f "$work/out/app.tfstate" ] || { log "no file at /out/app.tfstate"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q '^mode 600$' "$work/get.log" || { log "the file is not mode 600"; rc=1; }
    cmp -s "$work/out/app.tfstate" <(curl -fsS "$FLOCI/$bucket/app.tfstate?versionId=$v1") || { log "the file is not version $v1 as floci holds it"; rc=1; }
    git -C "$clone" fetch -q origin "+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle"
    done="$(git -C "$clone" show "refs/remotes/origin/chant/lifecycle:_gates/tf-state-export/done.jsonl" 2>/dev/null)"
    printf '%s\n' "$done" >&2
    jq -se --arg v "$v1" --arg d "$digest" 'map(select(.kind == "state-export" and .root == "app" and .version_id == $v and .exportedBy == "alice" and .approvedBy == "bob" and .planDigest == $d)) | length == 1' <<<"$done" >/dev/null \
      || { log "done.jsonl does not record alice exporting app version $v1, approved by bob"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci audit --link-hours 1 >&2 || { log "terragucci audit failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
    audit="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/audit.jsonl")" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }
    jq -c 'select(.kind == "state-export")' <<<"$audit" >&2
    jq -se --arg v "$v1" 'map(select(.kind == "state-export" and .who == "alice" and .what == "app" and .detail.version_id == $v and .detail.approved_by == "bob")) | length == 1' <<<"$audit" >/dev/null \
      || { log "the audit trail names no state-export of app by alice"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # The export added only the audit trail to the reports prefix, and no object there holds the state's lineage;
    # the audit trail holds no input value either (a plan report names the input, as any plan does).
    lineage="$(jq -r '.lineage // empty' "$work/out/app.tfstate")"
    [ -n "$lineage" ] || { log "the exported file has no lineage"; rc=1; }
    after="$(curl -fsS "$FLOCI/$REPORT_BUCKET?list-type=2&prefix=$prefix/" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' | sort)"
    added="$(comm -13 <(printf '%s\n' "$keys") <(printf '%s\n' "$after") | tr '\n' ' ')"
    [ "$added" = "$prefix/audit.html $prefix/audit.json $prefix/audit.jsonl " ] || { log "the export and audit added [$added] under $prefix, not the audit trail alone"; rc=1; }
    for key in $after; do
      if curl -fsS "$FLOCI/$REPORT_BUCKET/$key" | grep -q "$lineage"; then log "$key holds the state's lineage"; rc=1; fi
    done
    for key in $added; do
      if curl -fsS "$FLOCI/$REPORT_BUCKET/$key" | grep -q "se-$STAMP-"; then log "$key holds an input value from the state"; rc=1; fi
    done
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "alice exported app's state version $v1 once bob approved it: the file is the version, recorded on chant/lifecycle and in the audit trail, and no state reached the bucket"
  return $rc
}

claim_state/terragrunt_export() {
  # tg_state_versions_repo's unit, live/app, applies twice through Terragrunt
  # into a versioned floci bucket, its backend only in root.hcl's
  # remote_state block. In the Terragrunt image, as a person at a shell would:
  # terragucci state export live/app --version <the first> --actor alice
  # prepares the unit through Terragrunt, records a request for
  # s3://<bucket>/live/app/terraform.tfstate and exits 3. bob approves it in a
  # clone, and the same export writes the version to /out, mode 0600, byte for
  # byte the version floci holds, and done.jsonl names alice, live/app, its
  # state's location, the version and bob.
  # BREAK: TERRAGUCCI_TERRAGRUNT names no Terragrunt, so nobody prepares the
  # unit, and the export is refused and writes nothing.
  log() { echo "[smoke tg-state-export] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="tgexport-$STAMP" bucket="tgtse-$STAMP" key="live/app/terraform.tfstate" n v1="" v2="" digest code clone done
  local -a tg=()
  [ -n "${BREAK:-}" ] && tg=(-e TERRAGUCCI_TERRAGRUNT=/nonexistent/terragrunt)
  image="$(image_tag terragrunt)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example-terragrunt up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  mkdir -p "$work/out"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket?versioning" -H 'content-type: application/xml' \
    --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
    || { log "could not turn on versioning for $bucket"; return 1; }
  tg_state_versions_repo "$work" "$prefix" "$bucket" "tse-$STAMP-1"
  for n in 1 2; do
    [ $rc = 0 ] || break
    if [ $n = 2 ]; then
      tg_state_versions_unit "$work" "tse-$STAMP-2"
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "live/app input 2"
    fi
    AUDIT_CODE=0
    AUDIT_IMAGE=terragrunt audit_in "$work" env TG_TF_PATH=tofu TG_NON_INTERACTIVE=true terragucci stage tf-apply --wave 1 --layers live/app --binary tofu --gate never --terragrunt > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { cat "$work/run.log" >&2; log "apply $n exited $AUDIT_CODE, not 0"; rc=1; }
    [ $n = 1 ] && v1="$(curl -fsS -o /dev/null -D - "$FLOCI/$bucket/$key" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }')"
    [ $n = 2 ] && v2="$(curl -fsS -o /dev/null -D - "$FLOCI/$bucket/$key" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }')"
  done
  [ $rc = 0 ] && { [ -n "$v1" ] && [ -n "$v2" ] && [ "$v1" != "$v2" ] || { log "the bucket holds no two versions of $key ($v1, $v2)"; rc=1; }; }
  if [ $rc = 0 ]; then
    code=0
    STATE_IN_EXTRA=(-v "$work/out:/out" ${tg[@]+"${tg[@]}"})
    STATE_IN_IMAGE=terragrunt state_in "$work" terragucci state export live/app --version "$v1" --actor alice > "$work/ask.log" 2>&1 || code=$?
    STATE_IN_EXTRA=()
    clean_mounted "$work/wave" "$image"
    cat "$work/ask.log" >&2
    [ "$code" = 3 ] || { log "the request exited $code, not 3"; rc=1; }
    grep -q "state export: alice asks for live/app's state, s3://$bucket/$key version $v1" "$work/ask.log" || { log "the request does not name live/app's state as its remote_state block puts it"; rc=1; }
    digest="$(grep -o 'terragucci approve export live/app --plan sha256:[0-9a-f]*' "$work/ask.log" | head -1 | awk '{print $NF}')"
    [ -n "$digest" ] || { log "the request printed no terragucci approve command"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    clone="$work/approver"
    git clone -q "$work/origin.git" "$clone"
    (cd "$clone" && GIT_AUTHOR_NAME=bob GIT_AUTHOR_EMAIL=bob@localhost GIT_COMMITTER_NAME=bob GIT_COMMITTER_EMAIL=bob@localhost \
      "$TERRAGUCCI" approve export live/app --plan "$digest" --actor bob) >&2 || { log "bob could not approve the request"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    code=0
    # shellcheck disable=SC2016 # expanded by the container's shell
    STATE_IN_EXTRA=(-v "$work/out:/out")
    STATE_IN_IMAGE=terragrunt state_in "$work" sh -c 'terragucci state export live/app --version "$0" --actor alice --out /out/app.tfstate && stat -c "mode %a" /out/app.tfstate' "$v1" > "$work/get.log" 2>&1 || code=$?
    STATE_IN_EXTRA=()
    clean_mounted "$work/wave" "$image"
    cat "$work/get.log" >&2
    [ "$code" = 0 ] || { log "the export after bob's approval exited $code, not 0"; rc=1; }
    [ -f "$work/out/app.tfstate" ] || { log "no file at /out/app.tfstate"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q '^mode 600$' "$work/get.log" || { log "the file is not mode 600"; rc=1; }
    cmp -s "$work/out/app.tfstate" <(curl -fsS "$FLOCI/$bucket/$key?versionId=$v1") || { log "the file is not version $v1 as floci holds it"; rc=1; }
    git -C "$clone" fetch -q origin "+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle"
    done="$(git -C "$clone" show "refs/remotes/origin/chant/lifecycle:_gates/tf-state-export/done.jsonl" 2>/dev/null)"
    printf '%s\n' "$done" >&2
    jq -se --arg v "$v1" --arg d "$digest" --arg l "s3://$bucket/$key" 'map(select(.kind == "state-export" and .root == "live/app" and .location == $l and .version_id == $v and .exportedBy == "alice" and .approvedBy == "bob" and .planDigest == $d)) | length == 1' <<<"$done" >/dev/null \
      || { log "done.jsonl does not record alice exporting live/app version $v1 of $key, approved by bob"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "alice exported live/app's state version $v1 once bob approved it, the state Terragrunt's remote_state names, recorded on chant/lifecycle"
  return $rc
}

state_edges_roots() { # work, state bucket, network's input
  mkdir -p "$1/wave/network" "$1/wave/app"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "network.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "net" {\n  input = "%s"\n}\n\noutput "id" {\n  value = terraform_data.net.output\n}\n' "$2" "$3" > "$1/wave/network/main.tf"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "app.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\ndata "terraform_remote_state" "net" {\n  backend = "s3"\n  config = {\n    bucket         = "%s"\n    key            = "network.tfstate"\n    region         = "us-east-1"\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "app" {\n  input = data.terraform_remote_state.net.outputs.id\n}\n' "$2" "$2" > "$1/wave/app/main.tf"
}

claim_estate/state_edges() {
  # Two roots in one floci bucket: network, and app, which reads network's
  # state through terraform_remote_state. Wave 1 applies network and wave 2
  # app; then a change to network alone applies wave 1 again. terragucci
  # estate lists the edge app -> network as stale: app's last plan is its
  # wave 2, older than network's last apply. A tf-plan of both roots moves
  # app's last plan past it, and the next estate lists the edge as current.
  # No input value reaches edges.json or the page.
  # BREAK: the change to network is never applied, so the first estate lists
  # the edge as current, not stale.
  log() { echo "[smoke state-edges] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="edges-$STAMP" bucket="tgsg-$STAMP" project page html edges second="" wave
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  state_edges_roots "$work" "$bucket" "eg-$STAMP-1"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
  edges_wave() { # wave number -> AUDIT_CODE
    AUDIT_CODE=0
    audit_in "$work" terragucci stage tf-apply --wave "$1" --layers 'network;app' --binary tofu --gate never > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/run.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "wave $1 exited $AUDIT_CODE, not 0"; rc=1; }
  }
  for wave in 1 2; do [ $rc = 0 ] && edges_wave "$wave"; done
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    state_edges_roots "$work" "$bucket" "eg-$STAMP-2"
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "network input 2"
    second="$(git -C "$work/wave" rev-parse HEAD)"
    edges_wave 1
  fi
  edges_page() { # -> page and html of the estate
    audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.json")" || { log "no estate.json at $REPORT_BUCKET/$prefix"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
    jq -c '.projects[].edges[]? | {consumer, producer, via, status, planned: .consumer_planned | {stage, wave, finished}, applied: .producer_applied | {stage, wave, commit, finished}}' <<<"$page" >&2
  }
  [ $rc = 0 ] && edges_page
  if [ $rc = 0 ]; then
    jq -e '[.projects[].edges[]? | select(.consumer == "app" and .producer == "network" and .via == "terraform_remote_state")] | length == 1' <<<"$page" >/dev/null || { log "the page lists no edge app -> network"; rc=1; }
    jq -e '[.projects[].edges[]? | select(.consumer == "app") | .status] == ["stale"]' <<<"$page" >/dev/null || { log "the edge app -> network is not stale after network alone applied"; rc=1; }
    jq -e --arg c "$second" '[.projects[].edges[]? | select(.consumer == "app") | (.consumer_planned.wave == 2 and .producer_applied.commit == $c and .producer_applied.wave == 1)] == [true]' <<<"$page" >/dev/null || { log "the edge does not set app's wave 2 against network's apply of $second"; rc=1; }
    grep -q 'data-edge="app network" data-status="stale"' <<<"$html" || { log "estate.html does not show the edge as stale"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # A plan of both roots: app's last plan is now newer than network's last apply.
    AUDIT_CODE=0
    audit_in "$work" terragucci stage tf-plan --layers 'network;app' --binary tofu > "$work/plan.log" 2>&1 || AUDIT_CODE=$?
    cat "$work/plan.log" >&2
    clean_mounted "$work/wave" "$image"
    [ "$AUDIT_CODE" = 0 ] || { log "tf-plan exited $AUDIT_CODE, not 0"; rc=1; }
    [ $rc = 0 ] && edges_page
    [ $rc = 0 ] && { jq -e '[.projects[].edges[]? | select(.consumer == "app") | [.status, .consumer_planned.stage]] == [["current", "tf-plan"]]' <<<"$page" >/dev/null || { log "after app planned again, the edge is not current"; rc=1; }; }
  fi
  if [ $rc = 0 ]; then
    project="$(jq -r '.projects[0].project' <<<"$page")"
    edges="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/$project/edges.json")" || { log "no edges.json at $REPORT_BUCKET/$prefix/$project"; rc=1; }
    if grep -q "eg-$STAMP-" <<<"$edges$page$html"; then log "an input value reached edges.json or the page"; rc=1; fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the estate page set app's last plan against network's last apply: stale after network alone applied, current once app planned again, with no value"
  return $rc
}

# ── the MCP server ────────────────────────────────────────────────────────
claim_estate/mcp() {
  # A repo with one root, app (a terraform_data, local state), whose reports
  # go to the reports bucket under a fresh prefix, applied in tf-apply wave 1
  # with gate never. terragucci mcp then runs in the CI image over stdio, with
  # floci's keys in its environment and the bucket on its command line, and
  # the official SDK's client (stack/mcp-client.mjs) lists its tools and calls
  # them as an agent would. last_apply for app names the wave's commit,
  # wave 1, applied, and app's create of terraform_data.app. Every tool is
  # read-only and none is named for a write; a call to approve is refused with
  # the CLI's answer, and a token argument is refused.
  # BREAK: a bundle whose server lists an approve tool (break_bundle cuts
  # mcp.ts: the tool goes into TOOLS and the start-up guard is skipped), and
  # the tool list gives it away.
  log() { echo "[smoke mcp-last-apply] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" rc=0 prefix="mcp-$STAMP${BREAK:+-break}" out commit writes
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    # shellcheck disable=SC2016 # TypeScript, not shell
    break_bundle "$bundle" mcp.ts '  const tools = [...(o.tools ?? TOOLS), ...(o.propose ? PROPOSE_TOOLS : [])];
  assertReadOnly(tools);
' '  const tools = [...(o.tools ?? TOOLS), ...(o.propose ? PROPOSE_TOOLS : [])];
' mcp.ts 'export const TOOLS: Tool[] = [
' 'export const TOOLS: Tool[] = [
  { name: "approve", description: "Approve a waiting wave.", inputSchema: { type: "object", properties: { wave: { type: "string", description: "wave-<k>" } }, additionalProperties: false }, async run(a) { return `approved ${String(a.wave)}`; } },
' || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  audit_repo "$work" "$prefix"
  audit_wave "$work" never
  [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE, not 0"; drop_work "$work"; return 1; }
  commit="$(git -C "$work/wave" rev-parse HEAD)"
  # The server: the bundle copied into the CI image, stdin and stdout the protocol's, floci's keys in its environment.
  out="$(cd "$HERE/.." && node stack/mcp-client.mjs app -- bash -c '. "$1/mounted.sh"; shift; run_copied --rm -i "$@"' mcp "$HERE" \
    --network "${TG_NETWORK:-terragucci}" -v "$bundle:/usr/local/bin/terragucci:ro" "${AWS_DOCKER_ENV[@]}" \
    "$image" terragucci mcp --bucket "s3://$REPORT_BUCKET" --bucket-endpoint http://floci:4566 --bucket-prefix "$prefix")" \
    || { log "the MCP client failed"; drop_work "$work"; return 1; }
  jq -c '{server, tools: [.tools[].name], last_apply: (.last_apply.json // .last_apply.text | if type == "object" then {commit, wave, applied, approval, report, result: {path: .result.path, status: .result.status, changes: .result.changes}} else . end)}' <<<"$out" >&2
  writes="$(jq -r '[.tools[] | select((.name | test("approve|override|unlock|merge|revoke|^apply|write|delete|push")) or .readOnly == false or .destructive) | .name] | join(",")' <<<"$out")"
  if [ -n "$writes" ]; then log "the server lists tools that would write or are not read-only: $writes"; rc=1; fi
  [ "$(jq -r '.server.name' <<<"$out")" = terragucci ] || { log "the server is not terragucci"; rc=1; }
  jq -e '[.tools[].name] | index("last_apply") != null and index("estate") != null and index("audit") != null and index("dora") != null and index("state_versions") != null' <<<"$out" >/dev/null \
    || { log "the server does not list last_apply, estate, audit, dora and state_versions"; rc=1; }
  if jq -e '.last_apply.error' <<<"$out" >/dev/null; then
    log "last_apply for app failed: $(jq -r '.last_apply.text' <<<"$out")"; rc=1
  else
    jq -e --arg c "$commit" '.last_apply.json | .commit == $c and .wave == 1 and .applied == true and .result.path == "app" and .result.status == "planned"' <<<"$out" >/dev/null \
      || { log "last_apply does not name app's wave 1 at ${commit:0:8}, applied"; rc=1; }
    jq -e '.last_apply.json.result.changes | any(.address == "terraform_data.app" and .action == "create")' <<<"$out" >/dev/null \
      || { log "last_apply does not list the create of terraform_data.app"; rc=1; }
    [ "$(jq -r '.last_apply.json.report' <<<"$out")" = "$(jq -r '.index.json[0].report' <<<"$out")" ] || { log "last_apply's report is not the newest tf-apply row's"; rc=1; }
  fi
  jq -e '.approve.error and (.approve.text | contains("terragucci mcp is read-only") and contains("chant refuses a gate approval made over MCP"))' <<<"$out" >/dev/null \
    || { log "a call to approve was not refused with the CLI's answer: $(jq -r '.approve.text' <<<"$out")"; rc=1; }
  jq -e '.token.error and (.token.text | contains("reads credentials from its own environment"))' <<<"$out" >/dev/null \
    || { log "a token argument was not refused: $(jq -r '.token.text' <<<"$out")"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the client read app's last apply at ${commit:0:8} over MCP; every tool reads, and approve and a token argument were refused"
  return $rc
}

# ── the drift agent ───────────────────────────────────────────────────────
claim_agent/drift() {
  # A scratch repo with one root, app: a queue on floci with a visibility
  # timeout of 30, its state in floci's S3, and a drift schedule. terragucci.yml
  # turns agent.drift on with a stand-in agent: .smoke/drift-agent.sh reads
  # the prompt on stdin, and when it names visibility_timeout_seconds as live
  # 45 it sets the root's timeout to 45. The stand-in also says whether its
  # step holds any forge token and, if it does, pushes the branch
  # agent-direct with it. respond.drift is off. The agent's token
  # (AGENT_TOKEN) is the admin's.
  # The push to main applies the queue; then the timeout goes to 45 outside
  # OpenTofu, and the drift workflow runs once (workflow_dispatch). Its drift
  # job opens the drift issue, the drift-agent job runs the stand-in, and the
  # drift-agent-push job opens a pull request from terragucci/drift-agent-<n>
  # that sets the timeout to 45, comments its link on the issue, and the pull
  # request gets its own terragucci/plan statuses. main does not move, and no
  # agent-direct branch exists.
  # BREAK: the pushed pipeline gives the agent's step the agent's token
  # (TG_TOKEN), so the stand-in pushes agent-direct itself.
  log() { echo "[smoke drift-agent] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/drift-agent" queue="tg-drift-agent-$STAMP" key="respond/drift-agent-$STAMP.tfstate" url main_sha run status issue pr head i rc=0 wf s
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo drift-agent || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true,"has_issues":true}' "$URL/api/v1/repos/$repo"
  for s in AGENT_TOKEN:"$TOKEN" AGENT_KEY:stand-in; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "${s#*:}" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/${s%%:*}" \
      || { log "could not set the ${s%%:*} secret"; return 1; }
  done
  respond_tree "$work" "$repo" "$(respond_root "$key" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
  tags                       = { owner = \"smoke\" }
}")"
  mkdir -p "$work/tree/.smoke"
  cat > "$work/tree/.smoke/drift-agent.sh" <<'SH'
#!/bin/sh
# A stand-in drift agent: the prompt comes on stdin, and it edits one file.
prompt="$(cat)"
held=""
for v in GITHUB_TOKEN FORGEJO_TOKEN GITEA_TOKEN TG_TOKEN ACTIONS_RUNTIME_TOKEN; do
  eval "x=\${$v:-}"
  [ -n "$x" ] && held="$held $v"
done
echo "stand-in drift agent: forge tokens in its step:${held:- none}"
if [ -n "${TG_TOKEN:-}" ]; then
  git -c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$TG_TOKEN" | base64 -w0)" push -q "http://forgejo:3000/$GITHUB_REPOSITORY.git" HEAD:refs/heads/agent-direct \
    && echo "stand-in drift agent: pushed agent-direct with its own token"
fi
if printf '%s\n' "$prompt" | grep -q 'visibility_timeout_seconds: state 30, live 45'; then
  sed -i 's/visibility_timeout_seconds = 30/visibility_timeout_seconds = 45/' app/main.tf
  echo "stand-in drift agent: set app's visibility timeout to 45"
fi
SH
  printf 'gate: never\ndrift: "0 6 * * *"\nrespond:\n  drift: off\nagent:\n  via: forge\n  token_env: AGENT_TOKEN\n  drift:\n    command: sh .smoke/drift-agent.sh\n    key_secret: AGENT_KEY\n    timeout: 10\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q '^  drift-agent-push:' "$wf" || { log "the pipeline has no drift-agent-push job"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    # The agent's step gets the agent's token beside the model's key.
    awk '/^  drift-agent:/ { job = 1 } /^  drift-agent-push:/ { job = 0 } job && /^ +AGENT_KEY: / { print; match($0, /^ */); print substr($0, 1, RLENGTH) "TG_TOKEN: ${{ secrets.AGENT_TOKEN }}"; next } { print }' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
    grep -q 'TG_TOKEN: \${{ secrets.AGENT_TOKEN }}' "$wf" || { log "could not give the agent's step the token"; drop_work "$work"; return 1; }
  fi
  main_sha="$(push_tree "$work/tree" "$repo" main "drift-agent: a queue with a timeout of 30")" || { drop_work "$work"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true
  wait_run "$repo" "$main_sha" || { drop_work "$work"; return 1; }
  [ "$RUN_STATUS" = success ] || { log "the push to main did not go green ($RUN_STATUS)"; drop_work "$work"; return 1; }
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
  [ -n "$url" ] || { log "$queue is not in floci after the apply"; drop_work "$work"; return 1; }
  sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null
  # The drift workflow, once, as its schedule would run it.
  run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' "$URL/api/v1/repos/$repo/actions/workflows/terragucci.yml/dispatches" | jq -r '.id // empty' 2>/dev/null || true)"
  [ -n "$run" ] || { log "Forgejo did not start the drift workflow"; rc=1; }
  status=""
  if [ $rc = 0 ]; then
    for i in $(seq 1 $(( TIMEOUT / 3 ))); do
      status="$(api "$URL/api/v1/repos/$repo/actions/runs?event=workflow_dispatch&limit=50" | jq -r --arg r "$run" '[.workflow_runs // [] | .[] | select(.id == ($r | tonumber))] | (.[0].status // "")')"
      case "$status" in success|failure|cancelled|skipped) break ;; esac
      sleep 3
    done
    log "the drift run $run ended '${status:-unknown}'"
    print_logs "$repo" "$run" 2>/dev/null | grep -E 'terragucci( drift-agent)?:|stand-in drift agent|drift issue' | cut -c1-300 | sed 's/^/[smoke drift-agent]   /' >&2 || true
  fi
  if [ $rc = 0 ]; then
    issue="$(api "$URL/api/v1/repos/$repo/issues?state=open&type=issues&limit=50" | jq -r '[.[] | select((.body // "") | contains("<!-- terragucci:drift -->"))] | .[0].number // empty')"
    [ -n "$issue" ] || { log "the drift run opened no drift issue"; rc=1; }
  fi
  if [ -n "$(remote_head "$repo" agent-direct)" ]; then log "the agent's step held a forge token and pushed agent-direct itself"; rc=1; fi
  if [ $rc = 0 ]; then
    pr="$(open_pr "$repo" "terragucci/drift-agent-$issue")"
    if [ -z "$pr" ]; then
      log "no pull request from terragucci/drift-agent-$issue"; rc=1
    else
      head="$(remote_head "$repo" "terragucci/drift-agent-$issue")"
      [ "$(pr_files "$repo" "$pr")" = "app/main.tf" ] || { log "pull request $pr changes $(pr_files "$repo" "$pr"), not app/main.tf"; rc=1; }
      grep -q 'visibility_timeout_seconds = 45' <<<"$(file_at "$repo" "terragucci/drift-agent-$issue" "$head" app/main.tf)" || { log "pull request $pr does not set the timeout to 45"; rc=1; }
      [ "$(api "$URL/api/v1/repos/$repo/git/commits/$head" | jq -r '.parents[0].sha')" = "$main_sha" ] || { log "the agent's commit is not on top of main"; rc=1; }
      api "$URL/api/v1/repos/$repo/issues/$issue/comments?limit=50" | jq -r '.[].body' | grep -q "^terragucci: the drift agent opened .*/pulls/$pr" \
        || { log "drift issue $issue does not link pull request $pr"; rc=1; }
      for i in $(seq 1 $(( TIMEOUT / 3 ))); do
        [ "$(api "$URL/api/v1/repos/$repo/commits/$head/statuses?limit=100" | jq '[.[] | select(.context == "terragucci/plan")] | length')" -ge 1 ] && break
        sleep 3
      done
      [ "$(api "$URL/api/v1/repos/$repo/commits/$head/statuses?limit=100" | jq '[.[] | select(.context == "terragucci/plan")] | length')" -ge 1 ] \
        || { log "pull request $pr was not planned (no terragucci/plan status on ${head:0:8})"; rc=1; }
      [ $rc = 0 ] && log "drift issue $issue opened, and the drift agent's pull request $pr sets the timeout to 45 and was planned"
    fi
  fi
  [ "$(remote_head "$repo" main)" = "$main_sha" ] || { log "main moved"; rc=1; }
  [ -z "$url" ] || sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  drop_work "$work"
  [ $rc = 0 ] && log "the drift agent ran with no forge token and its change came back as a pull request that planned; nothing applied or merged"
  return $rc
}

# ── state migrations ──────────────────────────────────────────────────────
# A root in the migrate repo: a terraform_data per name, its state <root>.tfstate
# in the claim's state bucket (s3 backend, use_lockfile).
migrate_root() { # work, state bucket, root, names...
  local work="$1" bucket="$2" root="$3" n; shift 3
  mkdir -p "$work/wave/$root"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "%s"\n    key            = "%s.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n' "$bucket" "$root" > "$work/wave/$root/main.tf"
  for n in "$@"; do printf '\nresource "terraform_data" "%s" {\n  input = "mg-%s-%s"\n}\n' "$n" "$STAMP" "$n" >> "$work/wave/$root/main.tf"; done
}

migrate_approve() { # origin.git, clone dir, actor, gate, digest -> an approval line in _gates/tf-migrate.jsonl
  local origin="$1" clone="$2" actor="$3" gate="$4" digest="$5"
  if [ -d "$clone" ]; then git -C "$clone" pull -q --ff-only origin chant/lifecycle || return 1
  else git clone -q -b chant/lifecycle "$origin" "$clone" || return 1; fi
  # The approval is stamped to the second and must be newer than the pending line, which carries milliseconds.
  sleep 1
  printf '%s\n' "$(jq -cn --arg d "$digest" --arg g "$gate" --arg a "$actor" --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" '{version: 1, kind: "resolution", op: "tf-migrate", gate: $g, resolvedBy: $a, timestamp: $t, planDigest: $d}')" >> "$clone/_gates/tf-migrate.jsonl"
  git -C "$clone" -c user.name="$actor" -c user.email="$actor@localhost" -c commit.gpgsign=false commit -qam "approve $gate" && git -C "$clone" push -q origin chant/lifecycle
}

migrate_wave() { # work, log name, [layers] -> AUDIT_CODE of wave 1 over mono and split, or the layers given
  AUDIT_CODE=0
  audit_in "$1" terragucci stage tf-apply --wave 1 --layers "${3:-mono,split}" --binary tofu --gate never > "$1/$2.log" 2>&1 || AUDIT_CODE=$?
  cat "$1/$2.log" >&2
  clean_mounted "$1/wave" "$(image_tag tofu)"
}

# The cdktn-migrate claim's app: one stack per key of STACKS (JSON), each
# holding a terraform_data resource per name, its state in BUCKET under
# <stack>.tfstate with a lock file.
CDKTN_MIGRATE_APP='const { App, S3Backend, TerraformStack, TerraformResource } = require("cdktn");
const STACKS = JSON.parse(process.env.STACKS);
class Stack extends TerraformStack {
  constructor(scope, id, names) {
    super(scope, id);
    new S3Backend(this, { bucket: process.env.BUCKET, key: `${id}.tfstate`, region: "us-east-1", usePathStyle: true, useLockfile: true });
    for (const n of names) new TerraformResource(this, n, { terraformResourceType: "terraform_data" }).addOverride("input", `cm-${n}`);
  }
}
const app = new App();
for (const [name, names] of Object.entries(STACKS)) new Stack(app, name, names);
app.synth();
'

claim_migrate/cdktn() {
  # A CDK Terrain app on the cdktn fixture's packages, synthesized on the
  # host: stack mono holds terraform_data.keep and terraform_data.moved, its
  # state in a versioned bucket of the claim's own on floci, applied by wave
  # 1. The app then moves moved to a new stack, split, and
  # migrations/split-moved.yml names the two stacks' roots,
  # cdktf.out/stacks/mono and cdktf.out/stacks/split, which hold
  # cdk.tf.json and no .tf file. Wave 1 proves the migration on those roots
  # and waits for its digest, and once smoke-approver approves it writes both
  # states, plans both with no change, and applies nothing. mono.tfstate then
  # holds keep alone and split.tfstate moved. The pipeline step around it
  # (stage tf-plan printing the digest the wave waits for, the record,
  # done.jsonl) is migrate/split's; this part proves the CDK Terrain roots.
  # BREAK: split names the resource moved_too, so its address is not the one
  # the migration moves, the proof plans a change, and wave 1 does not wait.
  log() { echo "[smoke cdktn-migrate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 bucket="tgcm-$STAMP" stacks="cdktf.out/stacks/mono,cdktf.out/stacks/split" digest mono split moved=moved
  [ -n "${BREAK:-}" ] && moved=moved_too
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket" || { log "could not create the state bucket $bucket"; drop_work "$work"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$bucket?versioning" -H 'content-type: application/xml' \
    --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>' \
    || { log "could not turn on versioning for $bucket"; drop_work "$work"; return 1; }
  mkdir -p "$work/wave"
  cp "$HERE/fixtures/cdktn/package.json" "$HERE/fixtures/cdktn/package-lock.json" "$work/wave/"
  printf '{\n  "language": "javascript",\n  "app": "node main.js",\n  "projectId": "terragucci-smoke-cdktn-migrate",\n  "targetVersions": { "opentofu": ">=1.10.0" }\n}\n' > "$work/wave/cdktf.json"
  printf '%s' "$CDKTN_MIGRATE_APP" > "$work/wave/main.js"
  printf 'node_modules/\n' > "$work/wave/.gitignore"
  printf 'binary: tofu\n' > "$work/wave/terragucci.yml"
  synth() { (cd "$work/wave" && STACKS="$1" BUCKET="$bucket" npx cdktn synth >/dev/null 2>&1) || { log "cdktn synth failed on the host"; return 1; }; }
  (cd "$work/wave" && npm ci --no-audit --no-fund >/dev/null 2>&1) || { log "npm ci failed on the host"; drop_work "$work"; return 1; }
  synth '{"mono":["keep","moved"]}' || { drop_work "$work"; return 1; }
  [ -f "$work/wave/cdktf.out/stacks/mono/cdk.tf.json" ] && ! ls "$work/wave/cdktf.out/stacks/mono/"*.tf >/dev/null 2>&1 || { log "mono is not a root of cdk.tf.json alone"; drop_work "$work"; return 1; }
  audit_origin "$work"
  migrate_wave "$work" first cdktf.out/stacks/mono
  [ "$AUDIT_CODE" = 0 ] || { log "the first apply of mono exited $AUDIT_CODE, not 0"; rc=1; }
  if [ $rc = 0 ]; then
    synth "{\"mono\":[\"keep\"],\"split\":[\"$moved\"]}" || rc=1
    mkdir -p "$work/wave/migrations"
    printf 'moves:\n  - from: cdktf.out/stacks/mono\n    to: cdktf.out/stacks/split\n    addresses: [terraform_data.moved]\n' > "$work/wave/migrations/split-moved.yml"
    git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "moved goes from the mono stack to split"
  fi
  if [ $rc = 0 ]; then
    migrate_wave "$work" waits "$stacks"
    grep -q "^migration split-moved: every root plans with no change against its new state" "$work/waits.log" || { log "wave 1 did not prove the migration on the stacks' roots"; rc=1; }
    [ "$AUDIT_CODE" = 3 ] || { log "wave 1 exited $AUDIT_CODE, not 3: it did not wait for the migration"; rc=1; }
    digest="$(sed -n 's/^migration split-moved waits for an approval of digest \([^ ]*\)\. .*/\1/p' "$work/waits.log")"
    [ -n "$digest" ] || { log "wave 1 printed no digest to approve"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    migrate_approve "$work/origin.git" "$work/ledger" smoke-approver split-moved "$digest" || { log "could not approve the migration"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    migrate_wave "$work" applies "$stacks"
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE after the approval, not 0"; rc=1; }
    grep -q "^migration split-moved applied$" "$work/applies.log" || { log "the log does not say the migration applied"; rc=1; }
    grep -q "^wave 1 of 1: set digest .*, 0 changes, 0 destroys$" "$work/applies.log" || { log "the wave after the migration planned changes"; rc=1; }
    mono="$(curl -fsS "$FLOCI/$bucket/mono.tfstate" | jq -r '[.resources[].name] | join(",")')"
    split="$(curl -fsS "$FLOCI/$bucket/split.tfstate" | jq -r '[.resources[].name] | join(",")')"
    log "mono.tfstate holds [$mono], split.tfstate [$split]"
    [ "$mono" = keep ] && [ "$split" = moved ] || { log "mono holds [$mono] and split [$split], not keep and moved"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the migration moved terraform_data.moved from the mono stack's state to split's, proved with no change and applied once approved"
  return $rc
}

claim_migrate/resume() {
  # stack/fixtures/migrate-roots with gate: never: one root, mono, holding
  # keep and moved, and apply.resume: 5. No wave can wait under gate: never
  # and a migration still can, so init writes the resume workflow all the
  # same, pushed to Forgejo; its run applies mono.
  # A second push moves moved to a new root, split, with
  # migrations/split-moved.yml: wave 1 waits for the migration. In a clone,
  # terragucci approve with no argument finds the migration, prints chant
  # approve tf-migrate for its digest and records it (--no-resume). One run
  # of the resume workflow, dispatched as its schedule would start it, runs
  # wave 1 again: the migration writes both states and the wave applies.
  # mono's state then holds keep and split's moved, and chant/lifecycle's
  # done.jsonl says applied.
  # chant decides what a resume run resumes (an approval that answers the
  # pending fact and is not spent); this part proves what terragucci adds:
  # the workflow init writes, approve finding the migration, and the
  # migration the resumed wave writes.
  # BREAK: the resume workflow init wrote is removed before the push, as when
  # init wrote none under gate: never, so the approved migration stays
  # unwritten. A setup that breaks first (wave 1 not waiting, no approval)
  # proves nothing.
  local name=migrate-resume
  log() { echo "[smoke $name] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/$name" sha out run status deadline mono split done rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo "$name" migrate-roots || { drop_work "$work"; return 1; }
  printf 'gate: never\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init with gate: never failed"; drop_work "$work"; return 1; }
  # The resume workflow's schedule (apply.resume: 5) starts a run on main's
  # head every five minutes, which Forgejo lists with event push and the same
  # head sha as the push's own run: the waits take terragucci.yml's push run.
  sha="$(push_tree "$work/tree" "$repo" main "migrate-resume: mono")"
  WAIT_WORKFLOW=terragucci.yml WAIT_TRIGGER=push wait_run "$repo" "$sha" push || rc=1
  [ $rc = 0 ] && [ "$RUN_STATUS" = success ] || { log "the first run of mono ended ${RUN_STATUS:-unknown}"; rc=1; }
  if [ $rc = 0 ]; then
    perl -0pi -e 's/\n\nresource "terraform_data" "moved" \{\n  input = "moved"\n\}\n/\n/' "$work/tree/mono/main.tf"
    mkdir -p "$work/tree/split" "$work/tree/migrations"
    perl -pe 's#\@PREFIX\@/mono#'"$name"'/split#; s#mono.tfstate#split.tfstate#' "$HERE/fixtures/migrate-roots/mono/main.tf" | perl -0pe 's/\nresource "terraform_data" "keep" \{\n  input = "keep"\n\}\n//' > "$work/tree/split/main.tf"
    printf 'moves:\n  - from: mono\n    to: split\n    addresses: [terraform_data.moved]\n' > "$work/tree/migrations/split-moved.yml"
    (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init after the split failed"; rc=1; }
    [ -f "$work/tree/.forgejo/workflows/terragucci-resume.yml" ] || { log "init wrote no resume workflow under gate: never"; rc=1; }
    if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
      git -C "$work/tree" rm -q --cached .forgejo/workflows/terragucci-resume.yml 2>/dev/null || true
      mv "$work/tree/.forgejo/workflows/terragucci-resume.yml" "$work/resume.yml.dropped"
    fi
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "migrate-resume: split moved out of mono")"
    WAIT_WORKFLOW=terragucci.yml WAIT_TRIGGER=push wait_run "$repo" "$sha" push || rc=1
    [ $rc = 0 ] && { run_logs "$repo" "$RUN_ID" | grep -q 'terragucci approve split-moved --plan' || { log "wave 1 did not wait for the migration"; rc=1; }; }
  fi
  if [ $rc = 0 ]; then
    git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/approver-clone" || rc=1
    git -C "$work/approver-clone" config user.name smoke-approver
    git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    out="$(cd "$work/approver-clone" && PATH="$(dirname "$CHANT"):$PATH" "$TERRAGUCCI" approve --actor smoke-approver --no-resume 2>&1)" || { log "terragucci approve failed: $out"; rc=1; }
    log "terragucci approve: $(tr '\n' ' ' <<<"$out")"
    grep -q 'running: chant approve tf-migrate split-moved --plan' <<<"$out" || { log "terragucci approve did not approve the migration"; rc=1; }
  fi
  if [ $rc != 0 ] && [ -n "${BREAK:-}" ]; then log "the setup failed before the resume run, so BREAK proves nothing"; drop_work "$work"; return 0; fi
  if [ $rc = 0 ]; then
    dispatched() { api "$URL/api/v1/repos/$repo/actions/runs?event=workflow_dispatch&limit=50" | jq -c '.workflow_runs // []'; }
    if run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' \
        "$URL/api/v1/repos/$repo/actions/workflows/terragucci-resume.yml/dispatches" 2>/dev/null)"; then
      [ -n "${BREAK:-}" ] && { log "a resume workflow ran although the BREAK removed it, so BREAK proves nothing"; drop_work "$work"; return 0; }
      run="$(jq -r '.id // empty' <<<"$run" 2>/dev/null || true)"
      deadline=$(( $(date +%s) + TIMEOUT )); status=""
      while [ "$(date +%s)" -lt "$deadline" ]; do
        status="$(dispatched | jq -r --arg r "${run:-0}" '[.[] | select($r == "0" or .id == ($r | tonumber))] | (.[0].status // "")')"
        case "$status" in success|failure|cancelled|skipped) break ;; esac
        sleep 3
      done
      log "the dispatched resume run ${run:-?} ended '${status:-unknown}'"
      out="$( [ -n "$run" ] && print_logs "$repo" "$run" 2>/dev/null | grep -E 'terragucci resume|migration|wave [0-9]+' || true)"
      printf '%s\n' "$out" >&2
      resumed() { grep -q 'migration split-moved: approved by smoke-approver for this digest' <<<"$1" && grep -q 'migration split-moved applied' <<<"$1"; }
      if ! resumed "$out"; then
        # A scheduled run of the same workflow that started between the approval and the dispatch applies it first; it is then the resume run.
        for run in $(api "$URL/api/v1/repos/$repo/actions/runs?limit=50" | jq -r '.workflow_runs[]? | select(.trigger_event == "schedule" and .workflow_id == "terragucci-resume.yml") | .id'); do
          out="$(print_logs "$repo" "$run" 2>/dev/null | grep -E 'terragucci resume|migration|wave [0-9]+' || true)"
          resumed "$out" && { log "the scheduled resume run $run applied split-moved before the dispatched one"; printf '%s\n' "$out" >&2; break; }
        done
      fi
      resumed "$out" || { log "the resume run did not apply split-moved under smoke-approver's approval"; rc=1; }
    else
      log "Forgejo has no resume workflow to run in $repo"
      if [ -n "${BREAK:-}" ]; then
        # Approved, with no resume job, the migration stays unwritten.
        split="$(curl -fsS "$FLOCI/shop-terraform-state/$name/split.tfstate" 2>/dev/null | jq -r '[.resources[].name] | join(",")' 2>/dev/null)"
        drop_work "$work"
        if [ -z "$split" ]; then log "the approved migration waits with no resume job to run it"; return 1; fi
        log "split holds [$split] with no resume job, so BREAK proves nothing"; return 0
      fi
      rc=1
    fi
  fi
  if [ $rc = 0 ]; then
    mono="$(curl -fsS "$FLOCI/shop-terraform-state/$name/mono.tfstate" 2>/dev/null | jq -r '[.resources[].name] | join(",")' 2>/dev/null)"
    split="$(curl -fsS "$FLOCI/shop-terraform-state/$name/split.tfstate" 2>/dev/null | jq -r '[.resources[].name] | join(",")' 2>/dev/null)"
    log "after the resume run: mono holds [${mono:-}], split [${split:-}]"
    [ "$mono" = keep ] && [ "$split" = moved ] || { log "expected the resume run to move moved from mono to split"; rc=1; }
    git clone -q -b chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/ledger" 2>/dev/null || true
    done="$(cat "$work/ledger/_gates/tf-migrate/done.jsonl" 2>/dev/null)"
    [ "$(jq -r 'select(.gate == "split-moved") | .result' <<<"$done" 2>/dev/null)" = applied ] || { log "done.jsonl does not say split-moved applied"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "under gate: never init wrote the resume workflow, terragucci approve found the migration, and one resume run wrote both states with nobody running wave 1 again"
  return $rc
}

versioned_bucket() { # bucket -> created on floci with versioning on
  curl -fsS -o /dev/null -X PUT "$FLOCI/$1" || return 1
  curl -fsS -o /dev/null -X PUT "$FLOCI/$1?versioning" -H 'content-type: application/xml' \
    --data-binary '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'
}

current_version() { # bucket key -> the object's current version id
  curl -fsS -o /dev/null -D - "$FLOCI/$1/$2" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-amz-version-id" { print $2 }'
}

claim_migrate/backends() {
  # Six roots in one wave, each holding terraform_data.keep and
  # terraform_data.moved on a backend of its own, every server started at
  # once: s3 (bucket tgmb-old-<stamp>), tfe (a bucket whose state then seeds
  # workspace acme/app-prod of a TFE API, stack/fixtures/tfe-api/tfe.mjs,
  # HTTPS with a certificate the job trusts through NODE_EXTRA_CA_CERTS, as
  # sv-0002 over sv-0001, the same resources at the serial before), pg
  # (schema tgold of a Postgres of the claim's own, its password in
  # PGPASSWORD and never in the code), k8s (Secret suffix old on k3s's
  # control plane alone, its kubeconfig in KUBE_CONFIG_PATH), consul (path
  # tgold/app on one dev agent) and http (/state/old on the http state server
  # fixture, which refuses a write to a locked path without the lock's ID).
  # Wave 1 applies all six. One commit points each root's backend somewhere
  # new (s3 and tfe at bucket tgmb-new-<stamp>, schema tgnew, suffix new,
  # tgnew/app, /state/new) and adds migrations/move-backends.yml, a backends
  # entry per root whose from is where its state is now (tfe's the cloud
  # workspace). Wave 1 reads each source (tfe through discovery with the
  # token in TF_TOKEN_<host>; pg, k8s, consul and http with state pull),
  # proves the move and waits; smoke-approver approves the digest and wave 1
  # runs again. Each new state is written under its lock: s3's under both
  # lock files, tfe's under the workspace lock, and pg's, k8s's, consul's and
  # http's by the binary with state push under the advisory lock, the Lease,
  # the session lock and the server's lock. The wave applies no change. Each
  # new state holds both resources, each source is the state it was, no lock
  # is left, and the record names each root's source: the version read and
  # the version written where the backend keeps versions, none where it does
  # not. No input value, password or token reaches the record.
  # BREAK: after the approval every source moves: the old s3 object is
  # written again with the same body, the API drops sv-0002 so sv-0001 is
  # current, and pg's row, the old Secret, tgold/app and /state/old are
  # written again with the next serial. Caught only when wave 1 refuses
  # (exit 4) naming all six roots, so each backend's check that its source
  # moved since the approval holds. A setup that fails before the approval
  # proves nothing under BREAK.
  log() { echo "[smoke migrate-backends] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="migrate-backends-$STAMP" old="tgmb-old-$STAMP" new="tgmb-new-$STAMP" seed="tgmb-seed-$STAMP"
  local tfe_host="tgtfe$$x$RANDOM" tfe_token="smoke-tfe-$STAMP" pg_name="tgpg-$STAMP" pg_pass="smoke-pg-$STAMP" k8s_name="tgk8s-$STAMP" consul_name="tgconsul-$STAMP" http_name="tghttp-$STAMP"
  local tfe="" pg="" k8s="" consul="" srv="" tfe_ctl="" http_ctl="" port i r digest record moved missing conn
  local was_s3 was_pg was_k8s was_consul was_http
  local roots="s3 tfe pg k8s consul http"
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  down() {
    local c
    for c in "$tfe" "$pg" "$k8s" "$consul" "$srv"; do [ -n "$c" ] && { docker container remove --force "$c" >/dev/null 2>&1 || true; }; done
    drop_work "$work" "$image"
  }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  versioned_bucket "$old" && versioned_bucket "$new" && versioned_bucket "$seed" || { log "could not create the state buckets"; down; return 1; }
  mkdir -p "$work/wave" "$work/tfe" "$work/kube" "$work/http"
  cp "$HERE/fixtures/tfe-api/tfe.mjs" "$work/tfe/" && cp "$HERE/fixtures/http-backend/http-state.mjs" "$work/http/" || { down; return 1; }
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$tfe_host" -addext "subjectAltName=DNS:$tfe_host" \
    -keyout "$work/tfe/key.pem" -out "$work/tfe/cert.pem" >/dev/null 2>&1 || { log "openssl could not make the API's certificate"; down; return 1; }

  # Every server at once; each is waited for below.
  tfe="$(run_copied -d --name "$tfe_host" --network "${TG_NETWORK:-terragucci}" -p 127.0.0.1::8080 -e "TOKEN=$tfe_token" -v "$work/tfe:/tfe:ro" "$image" node /tfe/tfe.mjs)" || { log "the TFE API did not start"; rc=1; }
  pg="$(run_copied -d --name "$pg_name" --network "${TG_NETWORK:-terragucci}" -e "POSTGRES_PASSWORD=$pg_pass" -e POSTGRES_DB=app public.ecr.aws/docker/library/postgres:16)" || { log "Postgres did not start"; rc=1; }
  k8s="$(run_copied -d --name "$k8s_name" --network "${TG_NETWORK:-terragucci}" rancher/k3s:v1.33.6-k3s1 server --disable-agent --disable=traefik,servicelb,metrics-server,local-storage,coredns --tls-san="$k8s_name")" || { log "k3s did not start"; rc=1; }
  consul="$(run_copied -d --name "$consul_name" --network "${TG_NETWORK:-terragucci}" public.ecr.aws/hashicorp/consul:1.20 agent -dev -client=0.0.0.0)" || { log "Consul did not start"; rc=1; }
  srv="$(run_copied -d --name "$http_name" --network "${TG_NETWORK:-terragucci}" -p 127.0.0.1::8080 -v "$work/http:/http:ro" "$image" node /http/http-state.mjs)" || { log "the http state server did not start"; rc=1; }
  psql_app() { docker exec "$pg" psql -U postgres -d app -tAc "$1"; }
  kc() { docker exec "$k8s" kubectl "$@"; }
  ckv() { docker exec "$consul" consul kv "$@"; }
  secret_state() { kc get secret "tfstate-default-$1" -o jsonpath='{.data.tfstate}' | base64 -d | gunzip; }
  if [ $rc = 0 ]; then
    port="$(docker port "$tfe" 8080/tcp | head -1 | sed 's/.*://')"; tfe_ctl="http://127.0.0.1:$port"
    port="$(docker port "$srv" 8080/tcp | head -1 | sed 's/.*://')"; http_ctl="http://127.0.0.1:$port"
    for i in $(seq 1 30); do curl -fsS -o /dev/null "$tfe_ctl/status" 2>/dev/null && break; sleep 1; done
    curl -fsS -o /dev/null "$tfe_ctl/status" || { log "the TFE API never answered on $tfe_ctl"; rc=1; }
    for i in $(seq 1 30); do curl -fsS -o /dev/null "$http_ctl/_status" 2>/dev/null && break; sleep 1; done
    curl -fsS -o /dev/null "$http_ctl/_status" || { log "the http state server never answered on $http_ctl"; rc=1; }
    for i in $(seq 1 60); do docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres -d app 2>/dev/null && break; sleep 1; done
    docker exec "$pg" pg_isready -q -h 127.0.0.1 -U postgres -d app || { log "Postgres never took connections"; rc=1; }
    for i in $(seq 1 60); do ckv get -recurse >/dev/null 2>&1 && break; sleep 1; done
    ckv get -recurse >/dev/null 2>&1 || { log "Consul never answered"; rc=1; }
    for i in $(seq 1 90); do kc get namespace default >/dev/null 2>&1 && break; sleep 1; done
    kc get namespace default >/dev/null 2>&1 || { log "the Kubernetes API never answered"; rc=1; }
  fi
  [ $rc = 0 ] && { docker exec "$k8s" cat /etc/rancher/k3s/k3s.yaml | sed "s#https://127.0.0.1:6443#https://$k8s_name:6443#" > "$work/kube/config" || { log "could not read the kubeconfig"; rc=1; }; }
  # The job's view of the servers: the API's token and certificate, the
  # password as libpq reads it, the kubeconfig. None of it is in the code.
  local -a AWS_DOCKER_ENV=(${AWS_DOCKER_ENV[@]+"${AWS_DOCKER_ENV[@]}"} -e "TF_TOKEN_$tfe_host=$tfe_token" -e NODE_EXTRA_CA_CERTS=/tfe-ca/cert.pem -v "$work/tfe:/tfe-ca:ro" \
    -e "PGPASSWORD=$pg_pass" -e KUBE_CONFIG_PATH=/kube/config -v "$work/kube:/kube:ro")
  conn="postgres://postgres@$pg_name:5432/app?sslmode=disable"
  be_root() { # root, backend block
    mkdir -p "$work/wave/$1"
    printf 'terraform {\n  backend %s\n}\n' "$2" > "$work/wave/$1/main.tf"
    for n in keep moved; do printf '\nresource "terraform_data" "%s" {\n  input = "mg-%s-%s"\n}\n' "$n" "$STAMP" "$n" >> "$work/wave/$1/main.tf"; done
  }
  pg_backend() { printf '"pg" {\n    conn_str    = "%s"\n    schema_name = "%s"\n  }' "$conn" "$1"; }
  k8s_backend() { printf '"kubernetes" {\n    namespace     = "default"\n    secret_suffix = "%s"\n  }' "$1"; }
  consul_backend() { printf '"consul" {\n    address = "%s:8500"\n    scheme  = "http"\n    path    = "%s"\n  }' "$consul_name" "$1"; }
  http_backend() { printf '"http" {\n    address        = "http://%s:8080/state/%s"\n    lock_address   = "http://%s:8080/state/%s"\n    unlock_address = "http://%s:8080/state/%s"\n  }' "$http_name" "$1" "$http_name" "$1" "$http_name" "$1"; }
  migrate_root "$work" "$old" s3 keep moved
  migrate_root "$work" "$seed" tfe keep moved
  be_root pg "$(pg_backend tgold)"
  be_root k8s "$(k8s_backend old)"
  be_root consul "$(consul_backend tgold/app)"
  be_root http "$(http_backend old)"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
  if [ $rc = 0 ]; then
    migrate_wave "$work" first s3,tfe,pg,k8s,consul,http
    [ "$AUDIT_CODE" = 0 ] || { log "the first apply of the six roots exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    was_s3="$(current_version "$old" s3.tfstate)"
    curl -fsS "$FLOCI/$seed/tfe.tfstate" -o "$work/tfe.tfstate" || rc=1
    jq -c '.serial -= 1' "$work/tfe.tfstate" | curl -fsS -o /dev/null -X POST --data-binary @- "$tfe_ctl/versions" || rc=1
    curl -fsS -o /dev/null -X POST --data-binary @"$work/tfe.tfstate" "$tfe_ctl/versions" || rc=1
    [ $rc = 0 ] || log "could not give the workspace its versions"
  fi
  if [ $rc = 0 ]; then
    migrate_root "$work" "$new" s3 keep moved
    migrate_root "$work" "$new" tfe keep moved
    be_root pg "$(pg_backend tgnew)"
    be_root k8s "$(k8s_backend new)"
    be_root consul "$(consul_backend tgnew/app)"
    be_root http "$(http_backend new)"
    mkdir -p "$work/wave/migrations"
    {
      printf 'backends:\n'
      printf '  - root: s3\n    from:\n      backend: s3\n      config:\n        bucket: %s\n        key: s3.tfstate\n        region: us-east-1\n        use_lockfile: true\n        use_path_style: true\n' "$old"
      printf '  - root: tfe\n    from:\n      backend: cloud\n      config:\n        hostname: %s\n        organization: acme\n        workspaces:\n          name: app-prod\n' "$tfe_host"
      printf '  - root: pg\n    from:\n      backend: pg\n      config:\n        conn_str: %s\n        schema_name: tgold\n' "$conn"
      printf '  - root: k8s\n    from:\n      backend: kubernetes\n      config:\n        namespace: default\n        secret_suffix: old\n'
      printf '  - root: consul\n    from:\n      backend: consul\n      config:\n        address: %s:8500\n        scheme: http\n        path: tgold/app\n' "$consul_name"
      printf '  - root: http\n    from:\n      backend: http\n      config:\n        address: http://%s:8080/state/old\n        lock_address: http://%s:8080/state/old\n        unlock_address: http://%s:8080/state/old\n' "$http_name" "$http_name" "$http_name"
    } > "$work/wave/migrations/move-backends.yml"
    git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "six states to new backends"
    migrate_wave "$work" waits s3,tfe,pg,k8s,consul,http
    [ "$AUDIT_CODE" = 3 ] || { log "wave 1 exited $AUDIT_CODE, not 3: it did not wait for the move"; rc=1; }
    digest="$(sed -n 's/^migration move-backends waits for an approval of digest \([^ ]*\)\. .*/\1/p' "$work/waits.log")"
    [ -n "$digest" ] || { log "wave 1 printed no digest to approve"; rc=1; }
  fi
  [ $rc = 0 ] && { migrate_approve "$work/origin.git" "$work/ledger" smoke-approver move-backends "$digest" || { log "could not approve the move"; rc=1; }; }
  if [ $rc != 0 ] && [ -n "${BREAK:-}" ]; then log "the setup failed before the approval, so BREAK proves nothing"; down; return 0; fi

  if [ -n "${BREAK:-}" ]; then
    { curl -fsS "$FLOCI/$old/s3.tfstate" -o "$work/s3.body" && curl -fsS -o /dev/null -X PUT --data-binary @"$work/s3.body" "$FLOCI/$old/s3.tfstate"; } || { log "could not write the old s3.tfstate again"; rc=1; }
    curl -fsS -o /dev/null -X DELETE "$tfe_ctl/versions/last" || { log "could not drop the workspace's current version"; rc=1; }
    psql_app "update tgold.states set data = jsonb_set(data::jsonb, '{serial}', to_jsonb((data::jsonb->>'serial')::int + 1))::text where name = 'default'" >/dev/null || { log "could not write tgold's row again"; rc=1; }
    { secret_state old | jq -c '.serial += 1' | gzip -c | base64 | tr -d '\n' > "$work/next.b64" && [ -s "$work/next.b64" ] \
      && kc patch secret tfstate-default-old --type merge -p "{\"data\":{\"tfstate\":\"$(cat "$work/next.b64")\"}}" >/dev/null; } || { log "could not write the old Secret again"; rc=1; }
    { ckv get tgold/app | jq -c '.serial += 1' > "$work/next.json" && [ -s "$work/next.json" ] \
      && docker exec -i "$consul" consul kv put tgold/app - < "$work/next.json" >/dev/null; } || { log "could not write tgold/app again"; rc=1; }
    { curl -fsS "$http_ctl/state/old" | jq -c '.serial += 1' | curl -fsS -o /dev/null -X POST --data-binary @- "$http_ctl/state/old"; } || { log "could not write /state/old again"; rc=1; }
    [ $rc = 0 ] || { log "a source could not be moved, so BREAK proves nothing"; down; return 0; }
    migrate_wave "$work" applies s3,tfe,pg,k8s,consul,http
    moved="$(sed -n 's/.*and the states moved since: \(.*\); nothing was written.*/\1/p' "$work/applies.log" | head -1)"
    [ "$AUDIT_CODE" = 4 ] || { log "wave 1 exited $AUDIT_CODE with every source moved, not 4"; down; return 0; }
    missing=""
    for r in $roots; do case ", $moved, " in *", $r, "*) log "caught: $r's source moved since the approval" ;; *) missing="$missing $r" ;; esac; done
    down
    [ -z "$missing" ] || { log "wave 1 refused naming [$moved], and missed:$missing"; return 0; }
    log "wave 1 refused naming all six roots: [$moved]"
    return 1
  fi

  if [ $rc = 0 ]; then
    was_pg="$(psql_app "select md5(data) from tgold.states where name = 'default'")"
    was_k8s="$(secret_state old | shasum | cut -d' ' -f1)"
    was_consul="$(ckv get tgold/app | shasum | cut -d' ' -f1)"
    was_http="$(curl -fsS "$http_ctl/state/old" | shasum | cut -d' ' -f1)"
    migrate_wave "$work" applies s3,tfe,pg,k8s,consul,http
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE after the approval, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -q "^wave 1 of 1: set digest .*, 0 changes, 0 destroys$" "$work/applies.log" || { log "the wave after the move planned changes"; rc=1; }
    holds() { # label, state
      [ "$(jq -r '[.resources[].name] | join(",")' <<<"$2" 2>/dev/null)" = "keep,moved" ] || { log "$1 does not hold keep and moved"; rc=1; }
    }
    holds "s3's new state" "$(curl -fsS "$FLOCI/$new/s3.tfstate")"
    holds "tfe's new state" "$(curl -fsS "$FLOCI/$new/tfe.tfstate")"
    holds "schema tgnew" "$(psql_app "select data from tgnew.states where name = 'default'")"
    holds "the new Secret" "$(secret_state new)"
    holds "tgnew/app" "$(ckv get tgnew/app)"
    holds "/state/new" "$(curl -fsS "$http_ctl/state/new")"
    # Each source is the state it was.
    [ "$(current_version "$old" s3.tfstate)" = "$was_s3" ] || { log "the old s3.tfstate changed"; rc=1; }
    [ "$(psql_app "select md5(data) from tgold.states where name = 'default'")" = "$was_pg" ] || { log "tgold's row changed"; rc=1; }
    [ "$(secret_state old | shasum | cut -d' ' -f1)" = "$was_k8s" ] || { log "the old Secret changed"; rc=1; }
    [ "$(ckv get tgold/app | shasum | cut -d' ' -f1)" = "$was_consul" ] || { log "tgold/app changed"; rc=1; }
    [ "$(curl -fsS "$http_ctl/state/old" | shasum | cut -d' ' -f1)" = "$was_http" ] || { log "/state/old changed"; rc=1; }
    # No lock is left, and each write took its lock.
    case "$(curl -fsS "$FLOCI/$old?list-type=2" "$FLOCI/$new?list-type=2" | grep -o '<Key>[^<]*</Key>' | tr '\n' ' ')" in *.tflock*) log "an s3 lock file is left"; rc=1 ;; esac
    jq -c '{locked, versions, calls: [.calls[] | select(test("actions"))]}' <<<"$(curl -fsS "$tfe_ctl/status")" >&2
    [ "$(curl -fsS "$tfe_ctl/status" | jq -r '[.locked, (.versions | join(",")), ([.calls[] | select(test("actions/(un)?lock$")) | sub(".*/"; "")] | join(","))] | join(" ")')" = "false sv-0001,sv-0002 lock,unlock" ] \
      || { log "the workspace was not locked once and unlocked, or its versions changed"; rc=1; }
    [ "$(psql_app "select count(*) from pg_locks where locktype = 'advisory'")" = 0 ] || { log "an advisory lock is left"; rc=1; }
    [ -z "$(kc get lease lock-tfstate-default-new -o jsonpath='{.spec.holderIdentity}' 2>/dev/null || true)" ] || { log "the new state's Lease is still held"; rc=1; }
    # The binary deletes the lock key when it lets the lock go; its session expires with its TTL.
    [ "$(ckv get -keys -separator= tg | sort | tr '\n' ' ')" = "tgnew/app tgold/app " ] || { log "a consul lock is left: $(ckv get -keys -separator= tg | tr '\n' ' ')"; rc=1; }
    [ "$(curl -fsS "$http_ctl/_writes" | jq '[.[] | select(.path == "/state/new")] | length > 0 and all(.locked)')" = true ] || { log "/state/new was written outside its lock"; rc=1; }
    [ "$(curl -fsS "$http_ctl/_locks")" = "[]" ] || { log "an http lock is still held: $(curl -fsS "$http_ctl/_locks")"; rc=1; }
    # The record: each root's source, and the versions where the backend keeps them.
    record="$(cat "$work/wave/terragucci-report/migrations/move-backends.json" 2>/dev/null)"
    jq -c '{status, change, roots: [.roots[] | {root, location, source, after: .after.version_id}]}' <<<"$record" >&2
    [ "$(jq -r '[.status, .change] | join(" ")' <<<"$record")" = "applied backends" ] || { log "the record does not say the backends move applied"; rc=1; }
    rec() { jq -r --arg r "$1" ".roots[] | select(.root == \$r) | $2" <<<"$record"; }
    [ "$(rec s3 '[.source.location, .source.version_id, .after.version_id] | join(" ")')" = "s3://$old/s3.tfstate $was_s3 $(current_version "$new" s3.tfstate)" ] \
      || { log "the record does not name s3's source version and its new version"; rc=1; }
    [ "$(rec tfe '[.source.location, .source.version_id] | join(" ")')" = "cloud://$tfe_host/acme/app-prod sv-0002" ] \
      || { log "the record does not name the workspace and the version it read"; rc=1; }
    local unversioned='[.location, .source.location, (.source.version_id // "none"), (.after.version_id // "none")] | join(" ")'
    [ "$(rec pg "$unversioned")" = "pg:$pg_name:5432/app/tgnew.states pg:$pg_name:5432/app/tgold.states none none" ] || { log "the record does not name both pg addresses with no version id"; rc=1; }
    [ "$(rec k8s "$unversioned")" = "kubernetes:default/new kubernetes:default/old none none" ] || { log "the record does not name both kubernetes addresses with no version id"; rc=1; }
    [ "$(rec consul "$unversioned")" = "consul:$consul_name:8500/tgnew/app consul:$consul_name:8500/tgold/app none none" ] || { log "the record does not name both consul addresses with no version id"; rc=1; }
    [ "$(rec http "$unversioned")" = "http:http://$http_name:8080/state/new http:http://$http_name:8080/state/old none none" ] || { log "the record does not name both http addresses with no version id"; rc=1; }
    if grep -q "mg-$STAMP-\|$pg_pass\|$tfe_token" <<<"$record"; then log "an input value, the password or the token reached the record"; rc=1; fi
  fi
  down
  [ $rc = 0 ] && log "six states moved to new backends with no change, each under its lock, each source left as it was, the versions read and written recorded"
  return $rc
}

claim_migrate/split() {
  # Root mono holds terraform_data.keep and terraform_data.moved, its state
  # mono.tfstate in a versioned bucket of the claim's own on floci, applied by
  # wave 1. A commit moves the moved block to a new root, split, and adds
  # migrations/split-moved.yml. stage tf-plan proves the migration and prints
  # its digest. Wave 1 proves it again and waits for that digest;
  # smoke-approver approves it on chant/lifecycle, and wave 1 runs again: it
  # writes both states under their lock files, plans both with no change, and
  # its wave applies nothing. mono.tfstate then holds keep alone and
  # split.tfstate moved; the record names both roots' version before and
  # after, each after version the object's current one; done.jsonl on
  # chant/lifecycle says applied; no lock file is left; no input value reached
  # the record.
  # Then, on the same repo, terragucci migrate revert split-moved writes
  # migrations/split-moved-revert.yml from the record on chant/lifecycle, and
  # a commit puts the code back (moved in mono, split with no resources,
  # split-moved.yml removed). Wave 1 proves the revert and waits; approved, it
  # runs again: mono's state holds keep and moved again, as the version
  # before the split, split's state holds nothing, and the record names the
  # versions put back.
  # BREAK, each in turn on the one repo, caught only when both are:
  #   after the split's approval, mono.tfstate is written again with the same
  #   body, a new version, so wave 1 refuses (exit 4) naming mono and writes
  #   nothing; its new plan is then approved and applied;
  #   after the revert file is written, mono's state is written again (a new
  #   version past the one the split left), so wave 1 refuses the revert
  #   (exit 1) saying mono moved since.
  # A setup that fails before a break proves nothing.
  log() { echo "[smoke migrate-split] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="migrate-$STAMP" bucket="tgmg-$STAMP" planned digest record done keys mono split v before
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  nothing() { log "$1, so BREAK proves nothing"; drop_work "$work" "$image"; return 0; }
  rewrite_mono() { curl -fsS "$FLOCI/$bucket/mono.tfstate" -o "$work/mono.body" && curl -fsS -o /dev/null -X PUT --data-binary @"$work/mono.body" "$FLOCI/$bucket/mono.tfstate"; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  versioned_bucket "$bucket" || { log "could not create the state bucket $bucket"; return 1; }
  mkdir -p "$work/wave"
  migrate_root "$work" "$bucket" mono keep moved
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
  migrate_wave "$work" first mono
  [ "$AUDIT_CODE" = 0 ] || { log "the first apply of mono exited $AUDIT_CODE, not 0"; rc=1; }
  before="$(current_version "$bucket" mono.tfstate)"
  if [ $rc = 0 ]; then
    migrate_root "$work" "$bucket" mono keep
    migrate_root "$work" "$bucket" split moved
    mkdir -p "$work/wave/migrations"
    printf 'moves:\n  - from: mono\n    to: split\n    addresses: [terraform_data.moved]\n' > "$work/wave/migrations/split-moved.yml"
    git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "split moved out of mono"
    audit_in "$work" terragucci stage tf-plan --layers 'mono,split' --binary tofu > "$work/plan.log" 2>&1 || { log "stage tf-plan failed"; rc=1; }
    cat "$work/plan.log" >&2
    clean_mounted "$work/wave" "$image"
    planned="$(sed -n 's/^migration split-moved: every root plans with no change against its new state; digest //p' "$work/plan.log")"
    [ -n "$planned" ] || { log "stage tf-plan did not prove the migration"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    migrate_wave "$work" waits
    [ "$AUDIT_CODE" = 3 ] || { log "wave 1 exited $AUDIT_CODE, not 3: it did not wait for the migration"; rc=1; }
    digest="$(sed -n 's/^migration split-moved waits for an approval of digest \([^ ]*\)\. .*/\1/p' "$work/waits.log")"
    [ -n "$digest" ] && [ "$digest" = "$planned" ] || { log "wave 1 waits for [$digest], and the plan proved [$planned]"; rc=1; }
    grep -q "terragucci approve split-moved --plan $digest" "$work/waits.log" || { log "wave 1 does not print the approve command for the digest"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    migrate_approve "$work/origin.git" "$work/ledger" smoke-approver split-moved "$digest" || { log "could not approve the migration"; rc=1; }
  fi
  [ $rc != 0 ] && [ -n "${BREAK:-}" ] && { nothing "the split's setup failed before its break"; return 0; }
  if [ -n "${BREAK:-}" ]; then
    rewrite_mono || { nothing "could not write mono.tfstate again"; return 0; }
    migrate_wave "$work" refused
    { [ "$AUDIT_CODE" = 4 ] && grep -q "the states moved since: mono" "$work/refused.log"; } || { nothing "wave 1 exited $AUDIT_CODE with mono moved since the approval, not 4 naming mono"; return 0; }
    log "caught: wave 1 refused the split, mono's state moved since the approval"
    # The refusal's new plan, approved, so the revert has a split to put back.
    digest="$(sed -n 's/.*terragucci approve split-moved --plan \([^ ]*\).*/\1/p' "$work/refused.log" | tail -1)"
    [ -n "$digest" ] && migrate_approve "$work/origin.git" "$work/ledger" smoke-approver split-moved "$digest" || { nothing "could not approve the refusal's new plan"; return 0; }
    before="$(current_version "$bucket" mono.tfstate)"
  fi
  if [ $rc = 0 ]; then
    migrate_wave "$work" applies
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE after the approval, not 0"; rc=1; }
  fi
  [ $rc != 0 ] && [ -n "${BREAK:-}" ] && { nothing "the split did not apply under the new approval"; return 0; }
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    grep -q "^migration split-moved applied$" "$work/applies.log" || { log "the log does not say the migration applied"; rc=1; }
    grep -q "^wave 1 of 1: set digest .*, 0 changes, 0 destroys$" "$work/applies.log" || { log "the wave after the migration planned changes"; rc=1; }
    mono="$(curl -fsS "$FLOCI/$bucket/mono.tfstate" | jq -r '[.resources[].name] | join(",")')"
    split="$(curl -fsS "$FLOCI/$bucket/split.tfstate" | jq -r '[.resources[].name] | join(",")')"
    [ "$mono" = keep ] && [ "$split" = moved ] || { log "mono holds [$mono] and split [$split], not keep and moved"; rc=1; }
    record="$(cat "$work/wave/terragucci-report/migrations/split-moved.json" 2>/dev/null)" || { log "no migration record in terragucci-report/"; rc=1; }
    curl -fsS -o /dev/null "$FLOCI/$REPORT_BUCKET/$prefix/$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" | jq -r '.reports[0].project')/migrations/split-moved.json" || { log "the record was not copied to the reports bucket"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -z "${BREAK:-}" ]; then
    jq -c '{status, digest, roots: [.roots[] | {root, before, after: .after.version_id}]}' <<<"$record" >&2
    [ "$(jq -r .status <<<"$record")" = applied ] || { log "the record says $(jq -r .status <<<"$record"), not applied"; rc=1; }
    jq -e '[.roots[] | select(.root == "mono") | .before.version_id and .after.version_id and .before.version_id != .after.version_id] == [true]' <<<"$record" >/dev/null || { log "the record does not name mono's version before and after"; rc=1; }
    jq -e '[.roots[] | select(.root == "split") | .before.digest == null and (.after.version_id | type == "string")] == [true]' <<<"$record" >/dev/null || { log "the record does not say split had no state and name its version after"; rc=1; }
    for v in mono split; do
      [ "$(jq -r --arg r "$v" '.roots[] | select(.root == $r) | .after.version_id' <<<"$record")" = "$(current_version "$bucket" "$v.tfstate")" ] \
        || { log "the version recorded after for $v is not $v.tfstate's current one"; rc=1; }
    done
    done="$(git -C "$work/origin.git" show chant/lifecycle:_gates/tf-migrate/done.jsonl 2>/dev/null)"
    [ "$(jq -r 'select(.gate == "split-moved") | "\(.result) \(.approvedBy)"' <<<"$done")" = "applied smoke-approver" ] || { log "done.jsonl does not say split-moved applied under smoke-approver"; rc=1; }
    keys="$(curl -fsS "$FLOCI/$bucket?list-type=2" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' | tr '\n' ' ')"
    case "$keys" in *.tflock*) log "a lock file is left: $keys"; rc=1 ;; esac
    if grep -q "mg-$STAMP-" <<<"$record$done"; then log "an input value from a state reached the record"; rc=1; fi
    [ $rc = 0 ] && log "mono split into two with no change, approved by digest, written under lock, versions before and after recorded"
  fi

  # The revert of the split, on the same repo.
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci migrate revert split-moved > "$work/revert.log" 2>&1 || { log "terragucci migrate revert failed: $(cat "$work/revert.log")"; rc=1; }
    clean_mounted "$work/wave" "$image"
    cat "$work/wave/migrations/split-moved-revert.yml" >&2 || rc=1
    grep -q "version_id: \"$before\"" "$work/wave/migrations/split-moved-revert.yml" || { log "the revert does not put mono back to $before"; rc=1; }
  fi
  [ $rc != 0 ] && [ -n "${BREAK:-}" ] && { nothing "the revert file was not written"; return 0; }
  if [ $rc = 0 ]; then
    migrate_root "$work" "$bucket" mono keep moved
    migrate_root "$work" "$bucket" split
    git -C "$work/wave" rm -q migrations/split-moved.yml
    git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "revert the split"
    if [ -n "${BREAK:-}" ]; then rewrite_mono || { nothing "could not write mono.tfstate again before the revert"; return 0; }; fi
    migrate_wave "$work" revert-waits
    if [ -n "${BREAK:-}" ]; then
      { [ "$AUDIT_CODE" = 1 ] && grep -q "mono's state is at version .* it moved since" "$work/revert-waits.log"; } || { nothing "wave 1 exited $AUDIT_CODE on the revert with mono moved past the split, not 1 saying so"; return 0; }
      log "caught: wave 1 refused the revert, mono moved past the version the split left"
      drop_work "$work" "$image"
      return 1
    fi
    [ "$AUDIT_CODE" = 3 ] || { log "wave 1 exited $AUDIT_CODE, not 3: it did not wait for the revert"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    digest="$(sed -n 's/^migration split-moved-revert waits for an approval of digest \([^ ]*\)\. .*/\1/p' "$work/revert-waits.log")"
    migrate_approve "$work/origin.git" "$work/ledger" smoke-approver split-moved-revert "$digest" || { log "could not approve the revert"; rc=1; }
    migrate_wave "$work" revert-applies
    [ "$AUDIT_CODE" = 0 ] || { log "wave 1 exited $AUDIT_CODE after the revert's approval, not 0"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    mono="$(curl -fsS "$FLOCI/$bucket/mono.tfstate" | jq -r '[.resources[].name] | join(",")')"
    split="$(curl -fsS "$FLOCI/$bucket/split.tfstate" | jq -r '[.resources[].name] | join(",")')"
    [ "$mono" = "keep,moved" ] && [ -z "$split" ] || { log "mono holds [$mono] and split [$split], not keep,moved and nothing"; rc=1; }
    record="$(cat "$work/wave/terragucci-report/migrations/split-moved-revert.json" 2>/dev/null)"
    jq -c '{status, change, revert, roots: [.roots[] | {root, restore, after: .after.version_id}]}' <<<"$record" >&2
    [ "$(jq -r '[.status, .change, .revert, (.roots[] | select(.root == "mono") | .restore.version_id), (.roots[] | select(.root == "split") | .restore.version_id // "none")] | join(" ")' <<<"$record")" = "applied revert split-moved $before none" ] \
      || { log "the record does not say the revert applied mono's version before and split's empty state"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the revert put mono back to its version before the split and emptied split, approved by digest"
  return $rc
}

claim_estate/history() {
  # The audit repo (one root, app, holding terraform_data.app) with --gate
  # always and reports in the bucket. Three commits each set a new input; each
  # time wave 1 waits, approver-one, approver-two and approver-three approve it
  # in turn, and the next run applies. terragucci audit writes the record and
  # terragucci estate the history: terraform_data.app has three applies in
  # order, a create and two updates of input, approved by approver-one,
  # approver-two and approver-three, and the estate page links it. No input
  # value reaches changes.json, the history or the estate page.
  # BREAK: the second apply copies its report to another prefix, so neither
  # its report nor its changes are in the bucket and the history lists two.
  log() { echo "[smoke resource-history] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="history-$STAMP" n who project changes hist html page id got
  image="$(image_tag "$SMOKE_BINARY")"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  audit_repo "$work" "$prefix" || { log "the repo was not written for $SMOKE_BINARY"; drop_work "$work"; return 1; }
  for n in 1 2 3; do
    [ $rc = 0 ] || break
    case $n in 1) who=approver-one ;; 2) who=approver-two ;; 3) who=approver-three ;; esac
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "app" {\n  input = "hist-%s-%s"\n}\n' "$STAMP" "$n" > "$work/wave/app/main.tf"
    printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
    if [ -n "${BREAK:-}" ] && [ $n = 2 ]; then
      printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s-elsewhere\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
    fi
    bin_tree "$work/wave" "$prefix" || { log "change $n was not written for $SMOKE_BINARY"; rc=1; break; }
    git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "app input $n"
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 3 ] || { log "change $n: the first run exited $AUDIT_CODE, not 3: wave 1 did not wait"; rc=1; break; }
    audit_approve "$work/origin.git" "$work/ledger" "$who" wave-1 || { log "change $n: could not approve wave 1"; rc=1; break; }
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 0 ] || { log "change $n: the run after the approval exited $AUDIT_CODE, not 0"; rc=1; }
  done
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    project="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" | jq -r '.reports[0].project // empty')"
    changes="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/$project/changes.json")" || { log "no changes.json at $REPORT_BUCKET/$prefix/$project"; rc=1; }
    hist="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/history.json")" || { log "no history.json at $REPORT_BUCKET/$prefix"; rc=1; }
    html="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/history.html")" || { log "no history.html at $REPORT_BUCKET/$prefix"; rc=1; }
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -c '.resources[] | {address, applies: [.applies[] | {actions, attributes, approver, finished}]}' <<<"$hist" >&2
    got="$(jq -r '[.resources[] | select(.address == "terraform_data.app") | .applies[] | "\(.actions | join("+")) \(.approver)"] | join(",")' <<<"$hist")"
    [ "$got" = "create approver-one,update approver-two,update approver-three" ] \
      || { log "the history of terraform_data.app is [$got], not a create by approver-one and updates by approver-two and approver-three"; rc=1; }
    jq -e '[.resources[] | select(.address == "terraform_data.app") | .applies | (map(.finished) == (map(.finished) | sort)) and ([.[] | select(.actions == ["update"]) | .attributes | index("input")] | all(. != null))] == [true]' <<<"$hist" >/dev/null \
      || { log "the applies are not oldest first, or an update does not name input"; rc=1; }
    id="$(jq -r '.resources[] | select(.address == "terraform_data.app") | .id' <<<"$hist")"
    grep -q "<section id=\"$id\">" <<<"$html" || { log "history.html has no section for terraform_data.app"; rc=1; }
    grep -q "href=\"history.html#$id\"" <<<"$page" || { log "estate.html does not link terraform_data.app to its history"; rc=1; }
    if grep -q "hist-$STAMP-" <<<"$changes$hist$html$page"; then log "an input value reached changes.json, the history or the estate page"; rc=1; fi
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "terraform_data.app lists three applies in order, approved by approver-one, approver-two and approver-three, and no value"
  return $rc
}

claim_estate/query() {
  # A repo with one root, app, holding an SQS queue in floci and a
  # terraform_data, reports in the bucket, gate always. Change 1 creates both
  # and approver-one approves wave 1; change 2 moves the queue's timeout and
  # the data's input, and approver-two approves. After terragucci audit,
  # terragucci query, run on this machine against the bucket, answers
  # "the aws_sqs_queue resources changed in the last 7 days, with their
  # approvers": the queue's create by approver-one and its update by
  # approver-two, oldest first, no terraform_data, and each row's approver
  # is the one the audit trail's apply entry for that set digest names.
  # BREAK: the CLI is built with the history table left empty, so the query
  # returns no rows.
  log() { echo "[smoke query-sql] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="query-$STAMP" queue="query-$STAMP" n who timeout bundle out got want
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  bundle="$HERE/../packages/terragucci/dist/terragucci.mjs"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    break_bundle "$bundle" query.ts '  data.history = historyRows(buildHistory(changed, audit, now));' '  data.history = [];' || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  query_root() { # timeout, input -> app/main.tf
    printf 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n\n  backend "local" {}\n}\n\nprovider "aws" {\n  region = "us-east-1"\n}\n\nresource "aws_sqs_queue" "jobs" {\n  name                       = "%s"\n  visibility_timeout_seconds = %s\n  tags                       = { owner = "smoke" }\n}\n\nresource "terraform_data" "app" {\n  input = "%s"\n}\n' "$queue" "$1" "$2" > "$work/wave/app/main.tf"
  }
  mkdir -p "$work/wave/app"
  query_root 30 first
  cp "$EXAMPLE/envs/dev/platform/.terraform.lock.hcl" "$work/wave/app/"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
  for n in 1 2; do
    [ $rc = 0 ] || break
    case $n in 1) who=approver-one ;; 2) who=approver-two ;; esac
    if [ $n = 2 ]; then
      query_root 45 second
      git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qam "the queue's timeout moves"
    fi
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 3 ] || { log "change $n: the first run exited $AUDIT_CODE, not 3: wave 1 did not wait"; rc=1; break; }
    audit_approve "$work/origin.git" "$work/ledger" "$who" wave-1 || { log "change $n: could not approve wave 1"; rc=1; break; }
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 0 ] || { log "change $n: the run after the approval exited $AUDIT_CODE, not 0"; rc=1; }
  done
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_record "$prefix" "$work/audit.jsonl" || { log "no audit.jsonl at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    out="$(AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 node "$bundle" query --json \
      "SELECT address, actions, approver, set_digest FROM history WHERE type = 'aws_sqs_queue' AND julianday(finished) >= julianday('now', '-7 days') ORDER BY finished" \
      --bucket "s3://$REPORT_BUCKET" --bucket-endpoint "$FLOCI" --bucket-prefix "$prefix")" || { log "terragucci query failed: $out"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -c '.results.rows[]' <<<"$out" >&2
    got="$(jq -r '[.results.rows[] | "\(.address) \(.actions) \(.approver)"] | join(",")' <<<"$out")"
    [ "$got" = "aws_sqs_queue.jobs create approver-one,aws_sqs_queue.jobs update approver-two" ] \
      || { log "the query returned [$got], not the queue's create by approver-one and update by approver-two"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    # Each row's approver is the one the audit trail's apply entry for its set digest names.
    want="$(jq -rs '[.[] | select(.kind == "apply" and .who != null) | "\(.digest) \(.who)"] | sort | join(",")' "$work/audit.jsonl")"
    got="$(jq -r '[.results.rows[] | "\(.set_digest) \(.approver)"] | sort | join(",")' <<<"$out")"
    [ -n "$want" ] && [ "$got" = "$want" ] || { log "the rows name [$got], the audit trail's applies [$want]"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the query returned the queue's create by approver-one and update by approver-two, as the audit trail holds them"
  return $rc
}

claim_estate/dora() {
  # A repo with one root, app, holding an SQS queue in floci with a timeout
  # of 30, reports in the bucket. Change 1 is planned, waits at wave 1's gate
  # (gate always), smoke-approver approves it and the next run applies.
  # Change 2 is planned and applies with no gate. Change 3 is broken HCL and
  # its apply fails; change 4 fixes it and applies app again. Then the queue's
  # timeout is set to 45 in floci: a drift check finds app drifted, the
  # timeout goes back to 30 and the next check finds none. After terragucci
  # audit, terragucci estate writes dora.json, which holds to its schema:
  # three deployments, two changes with a lead time (one held at the gate),
  # four applies of which one failed and one drifted, a 50% change failure
  # rate, and two restores, the failed apply and the drift, none open. The
  # estate page shows the Delivery section.
  # BREAK: the failed apply's entry is dropped from audit.jsonl before the
  # estate job runs, so the record has three applies, none failed, and the
  # numbers change.
  log() { echo "[smoke dora] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work image rc=0 prefix="dora-$STAMP" queue="dora-$STAMP" url n dora page project code
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  curl -fsS -o /dev/null -X PUT "$FLOCI/$REPORT_BUCKET" || true
  dora_root() { # extra HCL -> app/main.tf, a queue with a tag, so floci reads no tags drift
    printf 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n\n  backend "local" {}\n}\n\nprovider "aws" {\n  region = "us-east-1"\n}\n\nresource "aws_sqs_queue" "jobs" {\n  name                       = "%s"\n  visibility_timeout_seconds = 30\n  tags                       = { owner = "smoke" }\n%s}\n' "$queue" "$1" > "$work/wave/app/main.tf"
  }
  dora_commit() { git -C "$work/wave" add -A && git -C "$work/wave" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "$1"; }
  dora_stage() { # stage args... -> AUDIT_CODE
    AUDIT_CODE=0
    audit_in "$work" terragucci stage "$@" --layers app > "$work/run.log" 2>&1 || AUDIT_CODE=$?
    grep -E 'wave 1|FAILED|drift' "$work/run.log" >&2 || true
    clean_mounted "$work/wave" "$image"
  }
  mkdir -p "$work/wave/app"
  dora_root ""
  cp "$EXAMPLE/envs/dev/platform/.terraform.lock.hcl" "$work/wave/app/"
  printf 'binary: tofu\nreports:\n  bucket: s3://%s\n  endpoint: http://floci:4566\n  prefix: %s\n' "$REPORT_BUCKET" "$prefix" > "$work/wave/terragucci.yml"
  audit_origin "$work"
  # Change 1: planned, waits at the gate, approved, applied.
  dora_stage tf-plan
  [ "$AUDIT_CODE" = 0 ] || { log "the plan of change 1 exited $AUDIT_CODE"; rc=1; }
  if [ $rc = 0 ]; then
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 3 ] || { log "change 1: wave 1 exited $AUDIT_CODE, not 3: it did not wait"; rc=1; }
  fi
  if [ $rc = 0 ]; then audit_approve "$work/origin.git" "$work/ledger" smoke-approver wave-1 || { log "could not approve wave 1"; rc=1; }; fi
  if [ $rc = 0 ]; then
    audit_wave "$work" always
    [ "$AUDIT_CODE" = 0 ] || { log "change 1: the run after the approval exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  # Change 2: planned, applied with no gate.
  if [ $rc = 0 ]; then
    dora_root '  delay_seconds              = 1
'
    dora_commit "change 2: a delay"
    dora_stage tf-plan
    [ "$AUDIT_CODE" = 0 ] || { log "the plan of change 2 exited $AUDIT_CODE"; rc=1; }
    audit_wave "$work" never
    [ "$AUDIT_CODE" = 0 ] || { log "change 2: wave 1 exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  # Change 3 fails to apply; change 4 fixes it and applies app again.
  if [ $rc = 0 ]; then
    printf 'resource "aws_sqs_queue" "broken" {\n' > "$work/wave/app/broken.tf"
    dora_commit "change 3: broken HCL"
    audit_wave "$work" never
    [ "$AUDIT_CODE" = 1 ] || { log "change 3: wave 1 exited $AUDIT_CODE, not 1: the apply did not fail"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    : > "$work/wave/app/broken.tf"
    dora_commit "change 4: the fix"
    audit_wave "$work" never
    [ "$AUDIT_CODE" = 0 ] || { log "change 4: wave 1 exited $AUDIT_CODE, not 0"; rc=1; }
  fi
  # A drift cycle: the timeout moves outside OpenTofu, then back.
  if [ $rc = 0 ]; then
    url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
    [ -n "$url" ] || { log "$queue is not in floci"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null || { log "could not change the timeout"; rc=1; }
    dora_stage tf-drift
    jq -e '[.roots[] | select(.path == "app" and (.changes | length > 0))] | length == 1' "$work/wave/terragucci-report/report.json" >/dev/null 2>&1 || { log "the drift check did not find app drifted"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"30\"}}" >/dev/null || { log "could not set the timeout back"; rc=1; }
    dora_stage tf-drift
    jq -e '[.roots[].changes[]] | length == 0' "$work/wave/terragucci-report/report.json" >/dev/null 2>&1 || { log "the second drift check still found drift"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_run "$work"
    [ "$AUDIT_CODE" = 0 ] || { log "terragucci audit exited $AUDIT_CODE"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/audit.jsonl" | jq -c 'select(.result != "failed")' \
      | curl -fsS -o /dev/null -X PUT -H 'content-type: application/x-ndjson' --data-binary @- "$FLOCI/$REPORT_BUCKET/$prefix/audit.jsonl" || { log "could not drop the failed apply"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    audit_in "$work" terragucci estate --link-hours 1 >&2 || { log "terragucci estate failed"; rc=1; }
    clean_mounted "$work/wave" "$image"
  fi
  if [ $rc = 0 ]; then
    curl -fsS -o "$work/dora.json" "$FLOCI/$REPORT_BUCKET/$prefix/dora.json" || { log "no dora.json at $REPORT_BUCKET/$prefix"; rc=1; }
    page="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/estate.html")" || { log "no estate.html at $REPORT_BUCKET/$prefix"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    (cd "$HERE/.." && npx tsx scripts/schema-check.ts packages/terragucci/dist/dora.schema.json "$work/dora.json") >&2 || { log "dora.json does not hold to dora.schema.json"; rc=1; }
    project="$(curl -fsS "$FLOCI/$REPORT_BUCKET/$prefix/index.json" | jq -r '.reports[0].project // empty')"
    dora="$(jq -c --arg p "$project" '.projects[] | select(.project == $p) | {deployments, lead: .lead_time.changes, gated: (.lead_time.at_gate_seconds != null and .lead_time.after_gate_seconds > 0), change_failure, restore}' "$work/dora.json")"
    log "dora: $dora"
    jq -e '.deployments == 3 and .lead == 2 and .gated and .change_failure == {applies: 4, failed: 1, drifted: 1, rate: 0.5} and .restore.restored == 2 and .restore.apply_restored == 1 and .restore.drift_restored == 1 and .restore.open == 0' <<<"$dora" >/dev/null \
      || { log "the metrics are not three deployments, two lead times one of them gated, a failed and a drifted apply of four, and two restores"; rc=1; }
    jq -e '.estate.deployments == 3 and .estate.change_failure.rate == 0.5 and (.weeks as $w | .estate.trend | length == $w) and (([.estate.trend[].deployments] | add) == 3)' "$work/dora.json" >/dev/null \
      || { log "the estate's metrics or this week's row do not match the project's"; rc=1; }
    grep -q '<table id="dora">' <<<"$page" && grep -q 'Change failure rate' <<<"$page" || { log "estate.html has no Delivery section"; rc=1; }
  fi
  n="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" 2>/dev/null | jq -r '.QueueUrl // empty')"
  [ -z "$n" ] || sqs DeleteQueue "{\"QueueUrl\":\"$n\"}" >/dev/null 2>&1 || true
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "dora.json counts three deployments, a 50% change failure rate from the failed apply and the drift, lead times with the gate's share, and both restores"
  return $rc
}

claim_notify/chat() {
  # The gated fixture (gate: always) with approval: pr-review and notify
  # naming two secrets, which hold the addresses of a webhook stand-in: one
  # path for Slack, one for Teams. A pull request changes canary/one and
  # merges with no review, so wave 1 of the merge commit waits, and its job
  # posts once to each: the Slack text and the Teams card both name the wave,
  # its root canary/one, the plan digest, the terragucci approve command for it,
  # the run, and a "Review and approve" link to the pull request's Files
  # changed page. A reviewer with write access then approves the merged pull
  # request's head on that page's API, `/terragucci apply` on the pull request
  # runs the wave again, and canary/one applies.
  # BREAK: approval is ledger, so the waiting wave's message links no review.
  log() { echo "[smoke notify-chat] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/notify-chat" name="tgs-chat-$STAMP" approval wf sha reqs slack teams s want link applied reply rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  approval=pr-review
  [ -z "${BREAK:-}" ] || approval=ledger
  gated_repo notify-chat gated-waves "$approval" || { drop_work "$work"; return 1; }
  printf 'notify:\n  slack: CHAT_SLACK\n  teams: CHAT_TEAMS\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  # shellcheck disable=SC2016 # the expression the forge expands
  grep -qF 'TERRAGUCCI_SLACK_WEBHOOK: '"'"'${{ secrets.CHAT_SLACK }}'"'" "$wf" || { log "the apply jobs do not map CHAT_SLACK"; drop_work "$work"; return 1; }
  for s in CHAT_SLACK:"http://$name:8790/slack" CHAT_TEAMS:"http://$name:8790/teams"; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "${s#*:}" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/${s%%:*}" \
      || { log "could not set the ${s%%:*} secret"; drop_work "$work"; return 1; }
  done
  stand_in_up "$work" "$name" 8790 MODE=webhook || { stand_in_down; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "notify-chat: two waves")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  # The pull request, planned, then merged with no review.
  [ $rc = 0 ] && { pr_reviewer "$repo" reviewer-notify-chat || rc=1; }
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/canary/one/rev.txt"
    REVIEW_HEAD="$(push_tree "$work/tree" "$repo" change "notify-chat: change canary/one")" || rc=1
  fi
  [ $rc = 0 ] && { REVIEW_PR="$(pr_open "$repo" change "notify-chat: change canary/one")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$REVIEW_HEAD" pull_request || rc=1; }
  [ $rc = 0 ] && { review_merge notify-chat || rc=1; }
  if [ $rc = 0 ]; then
    run_logs "$repo" "$RUN_ID" | grep -E 'terragucci approve wave-1|terragucci notify|approving review' >&2 || { log "wave 1 did not wait for its approval"; rc=1; }
    reqs="$(curl -fsS "$STANDIN_CTL/_requests" || echo '[]')"
    slack="$(jq -r '[.[] | select(.method == "POST" and .path == "/slack")] | last | .body.text // empty' <<<"$reqs")"
    teams="$(jq -c '[.[] | select(.method == "POST" and .path == "/teams")] | last | .body // empty' <<<"$reqs")"
    log "Slack got: ${slack:-nothing}"
    log "Teams got: ${teams:-nothing}"
    link="/pulls/$REVIEW_PR/files"
    for want in "wave 1 of" "canary/one" "Digest" "terragucci approve wave-1 --plan" "/actions/runs/" "Review and approve" "$link"; do
      grep -qF -- "$want" <<<"$slack" || { log "the Slack message does not say $want"; rc=1; }
      grep -qF -- "$want" <<<"$teams" || { log "the Teams card does not say $want"; rc=1; }
    done
    [ "$(jq -r '.attachments[0].contentType // empty' <<<"$teams")" = application/vnd.microsoft.card.adaptive ] || { log "the Teams body is not an Adaptive Card"; rc=1; }
    jq -e --arg l "$link" '.attachments[0].content.actions[0] | .title == "Review and approve" and (.url | endswith($l))' <<<"$teams" >/dev/null || { log "the Teams card's first button does not open the review"; rc=1; }
  fi
  # The review lands after the merge; the next run of the wave applies it.
  [ $rc = 0 ] && { review_approve notify-chat "$REVIEW_HEAD" || rc=1; }
  if [ $rc = 0 ]; then
    reply="$(pr_say "$repo" "$REVIEW_PR" "/terragucci apply")"
    applied="$(gated_applied notify-chat)"
    log "after the review: state for: ${applied:-nothing}; reply: ${reply:-none}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply on the review, wave 2 waiting at its own gate"; rc=1; }
  fi
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/reviewer-notify-chat?purge=true" 2>/dev/null || true
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "wave 1 waited; Slack and Teams each got the wave, its root, the digest, the approve command, the run and the review link; the review then applied it"
  return $rc
}

claim_notify/webhook() {
  # The gated fixture (gate: always) with notify naming a generic webhook and
  # its key: the secret HOOK_URL holds a stand-in receiver's address and
  # HOOK_KEY the key it verifies with. The push to main stops at wave 1, and
  # its job posts one event: X-Terragucci-Event waiting, a signature that
  # verifies over X-Terragucci-Timestamp and the raw body with the key, and a
  # chant.notify/v1 body from terragucci naming the project, forgejo, the
  # commit pushed, wave 1, canary/one, the digest and an id, whose detail (the
  # outcome) says waiting with the digest the job's terragucci approve command
  # names, the gate, mode ledger and that command. chant's notify signs and
  # posts the event; this part holds what terragucci adds: the config keys,
  # the pipeline mapping their secrets into the job, when it sends, the
  # X-Terragucci headers and the outcome it carries.
  # BREAK: the pushed pipeline maps no TERRAGUCCI_WEBHOOK_KEY into the jobs,
  # so the job has no key, and chant's notify, which never posts an event
  # unsigned, posts nothing.
  log() { echo "[smoke notify-webhook] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/notify-webhook" name="tgs-hook-$STAMP" key="smoke-hook-$STAMP" wf sha reqs hook digest rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo notify-webhook || { drop_work "$work"; return 1; }
  printf 'notify:\n  webhook: HOOK_URL\n  webhook_key: HOOK_KEY\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  # shellcheck disable=SC2016 # the expression the forge expands
  grep -qF 'TERRAGUCCI_WEBHOOK_KEY: '"'"'${{ secrets.HOOK_KEY }}'"'" "$wf" || { log "the apply jobs do not map HOOK_KEY"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed -i.bak '/TERRAGUCCI_WEBHOOK_KEY:/d' "$wf" && rm -f "$wf.bak"
    ! grep -q 'TERRAGUCCI_WEBHOOK_KEY:' "$wf" || { log "the BREAK did not cut the key's mapping"; drop_work "$work"; return 1; }
  fi
  for s in HOOK_URL:"http://$name:8790/hook" HOOK_KEY:"$key"; do
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "${s#*:}" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/${s%%:*}" \
      || { log "could not set the ${s%%:*} secret"; drop_work "$work"; return 1; }
  done
  stand_in_up "$work" "$name" 8790 MODE=webhook "HMAC_KEY=$key" || { stand_in_down; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "notify-webhook: two waves")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  if [ $rc = 0 ]; then
    digest="$(run_logs "$repo" "$RUN_ID" | grep -Eo 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' | head -1 | sed 's/.* --plan //')"
    [ -n "$digest" ] || { log "wave 1 did not wait for its approval"; rc=1; }
    run_logs "$repo" "$RUN_ID" | grep 'terragucci notify:' >&2 || true
    reqs="$(curl -fsS "$STANDIN_CTL/_requests" || echo '[]')"
    hook="$(jq -c '[.[] | select(.method == "POST" and .path == "/hook")] | last // empty' <<<"$reqs")"
    log "the receiver got: headers $(jq -c '.headers // {} | with_entries(select(.key | startswith("x-terragucci")))' <<<"${hook:-null}"), verified $(jq -r '.verified' <<<"${hook:-null}")"
    log "body: $(jq -c '.body' <<<"${hook:-null}")"
    [ -n "$hook" ] || { log "nothing was posted to the webhook"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    [ "$(jq -r '.verified' <<<"$hook")" = true ] || { log "the signature does not verify over the timestamp and the raw body with the receiver's key"; rc=1; }
    [ "$(jq -r '.headers["x-terragucci-event"]' <<<"$hook")" = waiting ] || { log "X-Terragucci-Event is not waiting"; rc=1; }
    jq -e --arg sha "$sha" --arg d "$digest" '.body | .schema == "chant.notify/v1" and .source == "terragucci" and .event == "waiting" and (.id | test("^[0-9a-f]{64}$")) and (.project | endswith("notify-webhook")) and .run.forge == "forgejo" and .run.commit == $sha and .wave.number == 1 and .targets == ["canary/one"] and .digest == $d and (.run.url | contains("/actions/runs/")) and .detail.schema == "terragucci.outcome/v1" and .detail.status == "waiting" and .detail.set_digest == $d and .detail.gate.name == "wave-1" and .detail.approval_mode == "ledger" and .detail.approve_command == ("terragucci approve wave-1 --plan " + $d)' <<<"$hook" >/dev/null \
      || { log "the event body is not as expected"; rc=1; }
  fi
  stand_in_down
  drop_work "$work"
  [ $rc = 0 ] && log "wave 1 waited, and the webhook got a signed chant.notify/v1 event with its outcome, digest and approve command"
  return $rc
}

# ── chat approvals through the relay ──────────────────────────────────────
# The gated fixture with apply.resume and notify naming a chat webhook and
# the relay, terragucci. The stand-in takes the chat message and stands in
# for Slack's response_url. The relay runs as a container on the stack's
# network, in the CI image, with a token of its own user: a write
# collaborator, with main protected so that user may not push there.

relay_user() { # repo, user -> sets RELAY_TOKEN, for a new user with write access and a token scoped write:repository and read:user
  local pass="smoke-$RANDOM-$RANDOM-Aa1" who="$2"
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/$who?purge=true" 2>/dev/null || true
  api -o /dev/null -H 'content-type: application/json' -X POST \
    -d "$(jq -cn --arg u "$who" --arg p "$pass" '{username: $u, email: ($u + "@terragucci.local"), password: $p, must_change_password: false}')" "$URL/api/v1/admin/users" || return 1
  api -o /dev/null -H 'content-type: application/json' -X PUT -d '{"permission":"write"}' "$URL/api/v1/repos/$1/collaborators/$who" || return 1
  RELAY_TOKEN="$(curl -fsS -u "$who:$pass" -H 'content-type: application/json' -X POST -d '{"name":"relay","scopes":["write:repository","read:user"]}' "$URL/api/v1/users/$who/tokens" | jq -r '.sha1 // empty')"
  [ -n "$RELAY_TOKEN" ] || { log "no token for $who"; return 1; }
}

# The Lambda Web Adapter and the Lambda runtime interface emulator, pinned by digest. With
# RELAY_LAMBDA=1 the relay runs as the function the guide builds: its Dockerfile, under the
# emulator, which stands in for Lambda's Runtime and Extensions APIs on the claim's own host.
LWA_IMAGE="public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0@sha256:17cfd08eff1dfea3f6a9a1e9c65fdac80aa4919b6085e746615530f43f57d2f1"
RIE_VERSION=v1.37
RIE_SHA256_arm64=ec2e5d09633d853834c008b1ef264bf834b258a94d551d2b2074966494b39a21
RIE_SHA256_x86_64=6b1e686e62ab2baf5759c412c4864276ef2a88b094fca53ec070637ccba9b9a5

relay_up() { # repo, name, KEY=VALUE... -> RELAY (container id), RELAY_URL (from the host)
  local repo="$1" name="$2" i hostport bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" kv arch sum port=8080 image
  shift 2
  local -a envs=() entry=()
  for kv in "$@"; do envs+=(-e "$kv"); done
  image="$(image_tag tofu)"
  if [ -n "${RELAY_LAMBDA:-}" ]; then
    case "$(docker info --format '{{.Architecture}}')" in aarch64|arm64) arch=arm64 ;; *) arch=x86_64 ;; esac
    sum="RIE_SHA256_$arch"
    mkdir -p "$work/lambda"
    curl -fsSLo "$work/lambda/aws-lambda-rie" "https://github.com/aws/aws-lambda-runtime-interface-emulator/releases/download/$RIE_VERSION/aws-lambda-rie-$arch" || { log "could not download the emulator"; return 1; }
    echo "${!sum}  $work/lambda/aws-lambda-rie" | shasum -a 256 -c - >/dev/null || { log "the emulator's sha256 is not ${!sum}"; return 1; }
    chmod +x "$work/lambda/aws-lambda-rie"
    cp "$bundle" "$work/lambda/terragucci"
    # The guide's Dockerfile, FROM this tree's image and bundle.
    cat > "$work/lambda/Dockerfile" <<DOCKERFILE
FROM $image
COPY --chmod=0755 terragucci /usr/local/bin/terragucci
COPY --from=$LWA_IMAGE /lambda-adapter /opt/extensions/lambda-adapter
ENV PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/healthz
CMD ["terragucci", "relay"]
DOCKERFILE
    docker build -q -t "terragucci-relay-lambda:smoke" "$work/lambda" >/dev/null || { log "the function's image did not build"; return 1; }
    image="terragucci-relay-lambda:smoke"
    # The emulator takes invocations on 9000, so the relay keeps 8080 as it has on Lambda.
    port=9000
    entry=(--entrypoint /rie/aws-lambda-rie -v "$work/lambda/aws-lambda-rie:/rie/aws-lambda-rie:ro")
    RELAY="$(run_copied -d --name "$name" --network "${TG_NETWORK:-terragucci}" -p 127.0.0.1::9000 ${entry[@]+"${entry[@]}"} \
      -e "TERRAGUCCI_RELAY_REPO=http://forgejo:3000/$repo.git" -e TERRAGUCCI_RELAY_FORGE=forgejo -e "TERRAGUCCI_RELAY_TOKEN=$RELAY_TOKEN" \
      ${envs[@]+"${envs[@]}"} "$image" --runtime-interface-emulator-address 0.0.0.0:9000 terragucci relay)" || return 1
  else
    RELAY="$(run_copied -d --name "$name" --network "${TG_NETWORK:-terragucci}" -p 127.0.0.1::8080 -v "$bundle:/usr/local/bin/terragucci:ro" \
      -e PORT=8080 -e "TERRAGUCCI_RELAY_REPO=http://forgejo:3000/$repo.git" -e TERRAGUCCI_RELAY_FORGE=forgejo -e "TERRAGUCCI_RELAY_TOKEN=$RELAY_TOKEN" \
      ${envs[@]+"${envs[@]}"} "$image" terragucci relay)" || return 1
  fi
  hostport="$(docker port "$RELAY" "$port/tcp" | head -1 | sed 's/.*://')"
  RELAY_URL="http://127.0.0.1:$hostport"
  for i in $(seq 1 60); do
    relay_post GET /healthz text/plain "" 2>/dev/null && [ "$RELAY_CODE" = 200 ] && { docker logs "$RELAY" 2>&1 | grep -i 'terragucci relay\|lambda\|adapter' | tail -4 >&2; return 0; }
    [ "$(docker inspect -f '{{.State.Running}}' "$RELAY" 2>/dev/null)" = true ] || break
    sleep 1
  done
  log "the relay never answered:"; docker logs "$RELAY" 2>&1 | tail -20 >&2
  return 1
}

# One request to the relay: straight to its port, or with RELAY_LAMBDA as the function URL
# event Lambda would hand the function, through the emulator's invoke endpoint.
relay_post() { # method, path, content type, body, [header: value]... -> RELAY_CODE, the answer's body in $work/answer
  local method="$1" path="$2" type="$3" body="$4" h event out
  shift 4
  if [ -z "${RELAY_LAMBDA:-}" ]; then
    local -a hs=()
    for h in "$@"; do hs+=(-H "$h"); done
    RELAY_CODE="$(curl -sS -o "$work/answer" -w '%{http_code}' -X "$method" -H "content-type: $type" ${hs[@]+"${hs[@]}"} ${body:+--data-binary "$body"} "$RELAY_URL$path")" || return 1
    return 0
  fi
  event="$(jq -cn --arg m "$method" --arg p "$path" --arg t "$type" --arg b "$body" --args '{version: "2.0", routeKey: "$default", rawPath: $p, rawQueryString: "", headers: ({"content-type": $t, host: "relay.lambda-url.us-east-1.on.aws"} + ([$ARGS.positional[] | capture("^(?<k>[^:]+): (?<v>.*)$") | {key: (.k | ascii_downcase), value: .v}] | from_entries)), requestContext: {domainName: "relay.lambda-url.us-east-1.on.aws", http: {method: $m, path: $p, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "smoke"}, requestId: "smoke", routeKey: "$default", stage: "$default", timeEpoch: 0}, body: $b, isBase64Encoded: false}' "$@")"
  out="$(curl -sS -X POST --data-binary "$event" "$RELAY_URL/2015-03-31/functions/function/invocations")" || return 1
  RELAY_CODE="$(jq -r '.statusCode // empty' <<<"$out" 2>/dev/null)"
  jq -r 'if .isBase64Encoded then (.body | @base64d) else (.body // "") end' <<<"$out" > "$work/answer" 2>/dev/null || return 1
  [ -n "$RELAY_CODE" ]
}

relay_down() {
  [ -n "${RELAY:-}" ] && { docker logs "$RELAY" 2>&1 | grep -v '^$' | tail -10 >&2; docker stop -t 2 "$RELAY" >/dev/null 2>&1 || true; }
  RELAY=""
}

chat_approve() { # slack|teams, [lambda]
  local app="$1" claim="chat-approve" work repo name stand sha digest reqs msg reply out code body ts sig secret who resolved run status deadline applied rc=0
  local RELAY_LAMBDA="${2:-}"
  [ "$app" = teams ] && claim="chat-approve-teams"
  [ -n "$RELAY_LAMBDA" ] && claim="chat-approve-lambda"
  log() { echo "[smoke $claim] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  repo="$USER/$claim"; name="tgs-relay-${claim#chat-approve}-$STAMP"; stand="tgs-chatin-${claim#chat-approve}-$STAMP"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo "$claim" || { drop_work "$work"; return 1; }
  # The approver's line in the signers file also lists their chat ids.
  echo "smoke-approver,slack:TSMOKE/UAPPROVER,teams:00000000-0000-0000-0000-00000000a001 $(cut -d' ' -f1,2 "$work/approver.pub")" > "$work/tree/.chant/allowed_signers"
  if [ "$app" = slack ]; then
    printf 'apply:\n  resume: 5\nnotify:\n  slack: CHAT_HOOK\n  relay: terragucci\n' >> "$work/tree/terragucci.yml"
  else
    printf 'apply:\n  resume: 5\nnotify:\n  teams: CHAT_HOOK\n  relay: terragucci\n' >> "$work/tree/terragucci.yml"
  fi
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "http://$stand:8790/$app" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/CHAT_HOOK" \
    || { log "could not set the CHAT_HOOK secret"; drop_work "$work"; return 1; }
  stand_in_up "$work" "$stand" 8790 MODE=webhook || { stand_in_down; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "$claim: two waves")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  if [ $rc = 0 ]; then
    digest="$(run_logs "$repo" "$RUN_ID" | grep -Eo 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' | head -1 | sed 's/.* --plan //')"
    [ -n "$digest" ] || { log "wave 1 did not wait for its approval"; rc=1; }
    reqs="$(curl -fsS "$STANDIN_CTL/_requests" || echo '[]')"
    msg="$(jq -c --arg p "/$app" '[.[] | select(.method == "POST" and .path == $p)] | last | .body // empty' <<<"$reqs")"
    [ -n "$msg" ] || { log "the wave posted nothing to $app"; rc=1; }
  fi
  # main takes pushes from the smoke's own user alone, so the relay's user may not push there.
  if [ $rc = 0 ]; then
    api -o /dev/null -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg u "$USER" '{rule_name: "main", branch_name: "main", enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: [$u]}')" \
      "$URL/api/v1/repos/$repo/branch_protections" || { log "could not protect main"; rc=1; }
  fi
  [ $rc = 0 ] && { relay_user "$repo" "relay-$claim" || rc=1; }
  if [ $rc = 0 ]; then
    secret="smoke-relay-$STAMP-$RANDOM"
    [ "$app" = teams ] && secret="$(printf '%s' "$secret" | base64)"
    if [ "$app" = slack ]; then
      relay_up "$repo" "$name" "SLACK_SIGNING_SECRET=$secret" "TERRAGUCCI_RELAY_SLACK_RESPONSE=http://$stand:8790/" || rc=1
    else
      relay_up "$repo" "$name" "TEAMS_WEBHOOK_SECRET=$secret" || rc=1
    fi
  fi
  # The click: the approver's, or under BREAK a user no line of the signers file lists.
  if [ $rc = 0 ]; then
    if [ "$app" = slack ]; then
      who=UAPPROVER; [ -z "${BREAK:-}" ] || who=UMALLORY
      jq -e --arg d "$digest" '.blocks[1].elements | map(.action_id) == ["terragucci-approve", "terragucci-decline"] and (.[0].value | fromjson) == {wave: 1, plan: $d}' <<<"$msg" >/dev/null \
        || { log "the Slack message has no Approve and Decline buttons for wave 1 and $digest: $(jq -c '.blocks // null' <<<"$msg")"; rc=1; }
      body="payload=$(jq -cn --arg u "$who" --arg v "$(jq -r '.blocks[1].elements[0].value' <<<"$msg")" --arg r "http://$stand:8790/response" \
        '{type: "block_actions", user: {id: $u, username: ("smoke-" + $u), team_id: "TSMOKE"}, team: {id: "TSMOKE"}, actions: [{action_id: "terragucci-approve", value: $v}], response_url: $r, container: {message_ts: "1700000000.000100"}}' | jq -sRr @uri)"
      ts="$(date +%s)"
      sig="v0=$(printf 'v0:%s:%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$secret" | sed 's/^.* //')"
      relay_post POST /slack application/x-www-form-urlencoded "$body" "X-Slack-Request-Timestamp: $ts" "X-Slack-Signature: $sig" || rc=1
      code="${RELAY_CODE:-}"
      reply="$(curl -fsS "$STANDIN_CTL/_requests" | jq -r '[.[] | select(.method == "POST" and .path == "/response")] | last | .body | select(.thread_ts == "1700000000.000100") | .text // empty')"
    else
      who=00000000-0000-0000-0000-00000000a001; [ -z "${BREAK:-}" ] || who=00000000-0000-0000-0000-00000000bad0
      jq -e --arg d "$digest" '.attachments[0].content.body | last | .text | contains("reply @terragucci approve wave-1 " + $d)' <<<"$msg" >/dev/null \
        || { log "the Teams card does not give the reply that approves wave 1 for $digest"; rc=1; }
      body="$(jq -cn --arg u "$who" --arg d "$digest" '{type: "message", id: "1700000000100", text: ("<at>terragucci</at> approve wave-1 " + $d), from: {id: "29:smoke", name: "Smoke Approver", aadObjectId: $u}}')"
      sig="HMAC $(printf '%s' "$body" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(printf '%s' "$secret" | base64 -d | od -An -tx1 | tr -d ' \n')" -binary | base64)"
      relay_post POST /teams application/json "$body" "Authorization: $sig" || rc=1
      code="${RELAY_CODE:-}"
      reply="$(jq -r '.text // empty' "$work/answer" 2>/dev/null)"
    fi
    log "the relay answered $code; in the thread: ${reply:-nothing}"
    [ "$code" = 200 ] || { log "the relay did not take the signed request"; rc=1; }
    case "$reply" in "wave-1 approved by smoke-approver, relayed by terragucci-relay, for $digest"*) ;; *) log "the thread does not say smoke-approver approved wave 1 for $digest"; rc=1 ;; esac
  fi
  if [ $rc = 0 ] || [ -n "${BREAK:-}" ]; then
    git clone -q "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$work/ledger" 2>/dev/null && git -C "$work/ledger" fetch -q origin chant/lifecycle 2>/dev/null
    resolved="$(git -C "$work/ledger" show origin/chant/lifecycle:_gates/tf-apply.jsonl 2>/dev/null | jq -sc --arg a "$app" '[.[] | select(.kind == "resolution" and .gate == "wave-1") | {resolvedBy, relayedBy, planDigest, via}]')"
    log "approvals of wave 1 on chant/lifecycle: ${resolved:-none}"
    jq -e --arg d "$digest" --arg a "$app" '. == [{resolvedBy: "smoke-approver", relayedBy: "terragucci-relay", planDigest: $d, via: $a}]' <<<"${resolved:-[]}" >/dev/null \
      || { log "chant/lifecycle does not hold one approval of $digest by smoke-approver, relayed by terragucci-relay"; rc=1; }
  fi
  # The resume job, once, as its schedule runs it: it applies a wave whose approval stands.
  if [ $rc = 0 ]; then
    if run="$(api -H 'content-type: application/json' -X POST -d '{"ref":"main","return_run_info":true}' "$URL/api/v1/repos/$repo/actions/workflows/terragucci-resume.yml/dispatches" 2>/dev/null)"; then
      run="$(jq -r '.id // empty' <<<"$run" 2>/dev/null || true)"
      deadline=$(( $(date +%s) + TIMEOUT )); status=""
      while [ "$(date +%s)" -lt "$deadline" ]; do
        status="$(api "$URL/api/v1/repos/$repo/actions/runs?event=workflow_dispatch&limit=50" | jq -r --arg r "${run:-0}" '[.workflow_runs // [] | .[] | select($r == "0" or .id == ($r | tonumber))] | (.[0].status // "")')"
        case "$status" in success|failure|cancelled|skipped) break ;; esac
        sleep 3
      done
      log "the dispatched resume run ${run:-?} ended '${status:-unknown}'"
    else
      log "Forgejo has no resume workflow to run in $repo"; rc=1
    fi
    applied="$(gated_applied "$claim")"
    log "after the resume run: state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected the resume run to apply canary/one"; rc=1; }
  fi
  relay_down
  stand_in_down
  api -o /dev/null -X DELETE "$URL/api/v1/admin/users/relay-$claim?purge=true" 2>/dev/null || true
  drop_work "$work"
  [ $rc = 0 ] && log "the $app click reached the relay, which recorded smoke-approver's approval of $digest and said so in the thread, and the resume run applied canary/one"
  return $rc
}

claim_chat/slack() {
  # A waiting wave's Slack message carries Approve and Decline buttons whose
  # value names wave 1 and its digest. A click by the Slack user the signers
  # file lists beside smoke-approver, signed as Slack signs with the app's
  # signing secret, reaches the relay; it records an approval of that digest
  # by smoke-approver, relayed by terragucci-relay, says so in the thread
  # through the response_url, and one run of the resume workflow applies
  # canary/one.
  # BREAK: the click is by a Slack user no line lists, so the relay refuses
  # it in the thread, records nothing, and nothing applies.
  chat_approve slack
}

claim_chat/lambda() {
  # As chat-approve, with the relay as the AWS Lambda function the guide
  # builds: its Dockerfile (the Lambda Web Adapter 1.1.0 extension, PORT and
  # the readiness path), run under the Lambda runtime interface emulator on
  # this host, so no AWS account is touched. Each request reaches it as the
  # function URL event Lambda hands the function: the signed Slack click,
  # the approval recorded as smoke-approver, the reply in the thread, and the
  # resume run applying canary/one.
  # BREAK: the click is by a Slack user no line lists, so the function
  # refuses it in the thread, records nothing, and nothing applies.
  chat_approve slack lambda
}

claim_chat/teams() {
  # A waiting wave's Teams card gives the reply @terragucci approve wave-1
  # <digest>. That reply by the Entra user the signers file lists beside
  # smoke-approver, signed as a Teams outgoing webhook signs it, reaches the
  # relay; its answer, which Teams posts under the message, says
  # smoke-approver approved that digest, chant/lifecycle holds the approval,
  # and one run of the resume workflow applies canary/one.
  # BREAK: the reply is by a Teams user no line lists, so the relay refuses
  # it, records nothing, and nothing applies.
  chat_approve teams
}

claim_chat/replan() {
  # A queue applied with a visibility timeout of 30, set to 45 outside
  # OpenTofu. With notify naming a Slack webhook and a drift schedule, the
  # drift job's commands (stage tf-drift, then notify drift) post the drifted
  # root to Slack with a Re-plan button. Its address is the repo's
  # terragucci.yml workflow page on Forgejo, which answers, and that workflow
  # runs on workflow_dispatch and holds the drift job, so Run workflow there
  # plans every root again.
  # BREAK: the timeout stays at 30, so there is no drift and nothing is posted.
  log() { echo "[smoke chat-replan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/chat-replan" name="tgs-replan-$STAMP" queue="tg-chat-replan-$STAMP" key="respond/chat-replan-$STAMP.tfstate" url reqs msg link wf rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo chat-replan || return 1
  respond_tree "$work" "$repo" "$(respond_root "$key" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
  tags                       = { owner = \"smoke\" }
}")"
  printf 'drift: "0 6 * * *"\nnotify:\n  slack: CHAT_SLACK\n' >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  push_tree "$work/tree" "$repo" main "a queue with a timeout of 30, and a drift schedule" >/dev/null || { drop_work "$work"; return 1; }
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true
  in_image "$work/tree" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "the apply failed"; drop_work "$work"; return 1; }
  clean_mounted "$work/tree"
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r '.QueueUrl // empty')"
  [ -n "$url" ] || { log "$queue is not in floci"; drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] || sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null
  stand_in_up "$work" "$name" 8790 MODE=webhook || { stand_in_down; drop_work "$work"; return 1; }
  # The drift job's script, as init wrote it, with the job's environment.
  in_image "$work/tree" env "GITHUB_REPOSITORY=$repo" GITHUB_SERVER_URL=http://forgejo:3000 GITHUB_API_URL=http://forgejo:3000/api/v1 GITHUB_RUN_ID=1 GITEA_ACTIONS=true \
    "TG_TOKEN=$TOKEN" "TERRAGUCCI_SLACK_WEBHOOK=http://$name:8790/slack" \
    sh -c 'terragucci stage tf-drift --forge forgejo --report-url "http://forgejo:3000/$GITHUB_REPOSITORY/actions"; rc=$?; terragucci notify drift --report terragucci-report || true; exit $rc' >&2 || { log "the drift run failed"; rc=1; }
  clean_mounted "$work/tree"
  if [ $rc = 0 ]; then
    reqs="$(curl -fsS "$STANDIN_CTL/_requests" || echo '[]')"
    msg="$(jq -c '[.[] | select(.method == "POST" and .path == "/slack")] | last | .body // empty' <<<"$reqs")"
    log "Slack got: $(jq -r '.text // "nothing"' <<<"${msg:-null}")"
    [ -n "$msg" ] || { log "the drift run posted nothing"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    jq -e '.text | contains("Drifted: app")' <<<"$msg" >/dev/null || { log "the message does not name app"; rc=1; }
    link="$(jq -r '.blocks[1].elements[] | select(.action_id == "terragucci-replan" and .text.text == "Re-plan") | .url' <<<"$msg")"
    log "the Re-plan button opens: ${link:-nothing}"
    [ "$link" = "http://forgejo:3000/$repo/actions?workflow=terragucci.yml" ] || { log "the Re-plan button does not open the drift workflow's page"; rc=1; }
    [ "$(curl -s -o /dev/null -w '%{http_code}' "${link/http:\/\/forgejo:3000/$URL}")" = 200 ] || { log "the Re-plan page does not answer"; rc=1; }
    wf="$(api "$URL/api/v1/repos/$repo/raw/.forgejo/workflows/terragucci.yml?ref=main")"
    grep -q 'workflow_dispatch' <<<"$wf" && grep -q 'terragucci stage tf-drift' <<<"$wf" || { log "terragucci.yml on main does not run the drift job on workflow_dispatch"; rc=1; }
  fi
  stand_in_down
  sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  drop_work "$work"
  [ $rc = 0 ] && log "the drift run posted app to Slack with a Re-plan button that opens the drift workflow, which Run workflow starts"
  return $rc
}

# The cost setup, which the plain runs of cost/estimate and cost/gate share on
# OpenTofu: a repo with two roots, app and net, in one wave, gate: never, and
# cost naming the secret COST_KEY, a command, cost.mjs, that sends the root's
# plan with that key to a cost stand-in (10.00 a month for each resource a
# plan creates, 401 without the key), and approve_above: 15. The push to main
# and a pull request that adds a resource to app run once, with the stand-in
# up; the setup keeps the main run's log (main.log), the pull request's plan
# note (note.md) and what the stand-in took (requests.json), and each part
# reads its own property from them. Their BREAK runs change the config, so
# each makes a repo of its own.
cost_make() {
  local repo="$USER/cost" name="tgs-cost-$STAMP" key="smoke-cost-$STAMP" tree="$work/tree" wf sha head pr root rc=0
  fresh_repo cost || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -cn --arg d "$key" '{data: $d}')" "$URL/api/v1/repos/$repo/actions/secrets/COST_KEY" \
    || { log "could not set the COST_KEY secret"; return 1; }
  for root in app net; do
    mkdir -p "$tree/$root"
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "%s" {\n  input = 1\n}\n' "$root" > "$tree/$root/main.tf"
  done
  cost_sender > "$tree/cost.mjs"
  printf 'binary: tofu\nforge: forgejo\ngate: never\nenv:\n  COST_URL: http://%s:8790/estimate\ncost:\n  key_secret: COST_KEY\n  command: node cost.mjs\n  approve_above: 15\n' "$name" > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
  wf="$tree/.forgejo/workflows/terragucci.yml"
  # shellcheck disable=SC2016 # the expression the forge expands
  grep -qF 'INFRACOST_API_KEY: '"'"'${{ secrets.COST_KEY }}'"'" "$wf" || { log "the jobs do not map COST_KEY"; return 1; }
  stand_in_up "$work" "$name" 8790 MODE=cost "REQUIRE=x-api-key=$key" || { stand_in_down; return 1; }
  sha="$(push_tree "$tree" "$repo" main "cost: two roots")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  [ $rc = 0 ] && run_logs "$repo" "$RUN_ID" > "$work/main.log"
  if [ $rc = 0 ]; then
    printf '\nresource "terraform_data" "more" {\n  input = 2\n}\n' >> "$tree/app/main.tf"
    head="$(push_tree "$tree" "$repo" change "cost: one more resource in app")" || rc=1
    git -C "$tree" checkout -q main
  fi
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "cost: one more resource in app")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    echo "$pr" > "$work/pr"
    api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty' > "$work/note.md"
    curl -fsS "$STANDIN_CTL/_requests" > "$work/requests.json" || echo '[]' > "$work/requests.json"
  fi
  stand_in_down
  return $rc
}

cost_sender() { # -> cost.mjs: sends the root's plan to the cost stand-in with the key, and prints its estimate
  cat <<'JS'
// Sends the root's plan to the cost stand-in with the key, and prints its estimate.
import { readFileSync } from "node:fs";
const r = await fetch(process.env.COST_URL, { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.INFRACOST_API_KEY ?? "" }, body: readFileSync(process.env.TG_PLAN_JSON) });
if (!r.ok) {
  console.error(`the cost stand-in answered ${r.status}`);
  process.exit(1);
}
process.stdout.write(await r.text());
JS
}

cost_estimate_holds() { # note, the stand-in's requests -> 0 when the note gives app +20.00 and a total of +20.00, estimated with the key
  local note="$1" reqs="$2" rc=0
  grep -E 'Monthly cost|^\| ' <<<"$note" >&2 || true
  grep -qF 'Monthly cost (USD' <<<"$note" || { log "the plan note has no cost table"; rc=1; }
  grep -qE '^\| \[?`app`.* \| 0\.00 \| 20\.00 \| \+20\.00 \|$' <<<"$note" || { log "the cost table does not give app +20.00"; rc=1; }
  grep -qF '| **Total** | 0.00 | 20.00 | **+20.00** |' <<<"$note" || { log "the cost table does not total +20.00"; rc=1; }
  [ "$(jq '[.[] | select(.path == "/estimate" and .status == 200)] | length' <<<"${reqs:-[]}")" -ge 1 ] \
    || { log "the cost stand-in took no estimate with the key"; rc=1; }
  return $rc
}

cost_gate_holds() { # main run's log, note -> 0 when wave 1 waited for its cost under gate: never and the note set it against the amount at base
  local logs="$1" note="$2" rc=0
  grep -E 'cost|waits|approve' <<<"$logs" | grep -v '^\s*$' | tail -12 >&2 || true
  grep -qE "the monthly cost changes by \+20\.00 USD, over cost\.approve_above 15\.00 USD in the config at [0-9a-f]{40}, so it waits for an approval although gate is never" <<<"$logs" \
    || { log "wave 1 did not wait for its cost, naming +20.00 USD and the amount 15.00 USD"; rc=1; }
  grep -qE 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' <<<"$logs" || { log "wave 1 gave no approve command"; rc=1; }
  grep -E 'Monthly cost|approve_above|^\| [0-9]' <<<"$note" >&2 || true
  grep -qF 'Against `cost.approve_above` at base, 15.00 USD a month: wave 1 +20.00 USD, over it: it waits for an approval whatever the gate.' <<<"$note" \
    || { log "the plan note does not set wave 1's +20.00 USD against the amount at base"; rc=1; }
  grep -qE '^\| 1 \| [0-9]+ \| .* \| waits for an approval' <<<"$note" || { log "the note's wave table does not say wave 1 waits"; rc=1; }
  return $rc
}

claim_cost/estimate() {
  # Plain, on the cost setup: the pull request that adds a resource to app
  # gets a plan note whose cost table names app at +20.00 (its two
  # resources, as the job holds no state) and a total of +20.00, and the
  # stand-in took the estimate with the key the plan job got from COST_KEY.
  # BREAK: a repo of its own whose terragucci.yml has no cost, so the plan
  # runs no estimator and the note has no cost table.
  log() { echo "[smoke cost/estimate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cost-estimate" name="tgs-cost-$STAMP" tree sha head pr note root rc=0
  if [ -z "${BREAK:-}" ]; then
    setup_local cost cost_make || return 1
    cost_estimate_holds "$(cat "$SETUP_DIR/note.md" 2>/dev/null)" "$(cat "$SETUP_DIR/requests.json" 2>/dev/null)" || rc=1
    [ $rc = 0 ] && log "the plan note gave app +20.00 a month and a total of +20.00, estimated with the key from the COST_KEY secret"
    return $rc
  fi
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo cost-estimate || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for root in app net; do
    mkdir -p "$tree/$root"
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "%s" {\n  input = 1\n}\n' "$root" > "$tree/$root/main.tf"
  done
  cost_sender > "$tree/cost.mjs"
  printf 'binary: tofu\nforge: forgejo\ngate: never\nenv:\n  COST_URL: http://%s:8790/estimate\n' "$name" > "$tree/terragucci.yml"
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  stand_in_up "$work" "$name" 8790 MODE=cost || { stand_in_down; drop_work "$work"; return 1; }
  sha="$(push_tree "$tree" "$repo" main "cost-estimate: two roots")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  if [ $rc = 0 ]; then
    printf '\nresource "terraform_data" "more" {\n  input = 2\n}\n' >> "$tree/app/main.tf"
    head="$(push_tree "$tree" "$repo" change "cost-estimate: one more resource in app")" || rc=1
    git -C "$tree" checkout -q main
  fi
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "cost-estimate: one more resource in app")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty')"
    cost_estimate_holds "$note" "$(curl -fsS "$STANDIN_CTL/_requests" || echo '[]')" || rc=1
  fi
  stand_in_down
  drop_work "$work"
  return $rc
}

claim_cost/gate() {
  # Plain, on the cost setup: the push to main plans app and net, +20.00 a
  # month, over approve_above: 15, and wave 1 waits for an approval although
  # the gate is never: its log names +20.00 USD, the amount 15.00 USD and the
  # commit it was read at, and gives the approve command. The pull request
  # that adds a resource to app gets a plan note that sets wave 1's change
  # against the amount at base, over it, so the wave waits. Under another
  # binary the part makes a repo of its own, with cost.mjs pricing locally
  # and no key.
  # BREAK: a repo of its own whose terragucci.yml has no approve_above, so
  # the wave applies under gate: never and the note sets nothing against an
  # amount.
  log() { echo "[smoke cost/gate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/cost-gate" tree sha head pr note logs root rc=0
  if [ -z "${BREAK:-}" ] && [ "$SMOKE_BINARY" = tofu ]; then
    setup_local cost cost_make || return 1
    cost_gate_holds "$(cat "$SETUP_DIR/main.log" 2>/dev/null)" "$(cat "$SETUP_DIR/note.md" 2>/dev/null)" || rc=1
    [ $rc = 0 ] && log "wave 1 waited under gate: never for its +20.00 USD over 15.00 USD, and the plan note set the change against the amount at base"
    return $rc
  fi
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  tree="$work/tree"
  fresh_repo cost-gate || { drop_work "$work"; return 1; }
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$repo"
  for root in app net; do
    mkdir -p "$tree/$root"
    printf 'terraform {\n  backend "local" {}\n}\n\nresource "terraform_data" "%s" {\n  input = 1\n}\n' "$root" > "$tree/$root/main.tf"
  done
  cp "$HERE/fixtures/cost-policy/cost.mjs" "$tree/cost.mjs"
  printf 'binary: tofu\nforge: forgejo\ngate: never\ncost:\n  command: node cost.mjs\n' > "$tree/terragucci.yml"
  [ -n "${BREAK:-}" ] || printf '  approve_above: 15\n' >> "$tree/terragucci.yml"
  bin_tree "$tree" "cost-gate-$(date +%s)" || { log "the tree was not written for $SMOKE_BINARY"; drop_work "$work"; return 1; }
  (cd "$tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; drop_work "$work"; return 1; }
  bin_pipeline "$tree/.forgejo/workflows/terragucci.yml" || { drop_work "$work"; return 1; }
  sha="$(push_tree "$tree" "$repo" main "cost-gate: two roots")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  [ $rc = 0 ] && logs="$(run_logs "$repo" "$RUN_ID")"
  if [ $rc = 0 ]; then
    printf '\nresource "terraform_data" "more" {\n  input = 2\n}\n' >> "$tree/app/main.tf"
    head="$(push_tree "$tree" "$repo" change "cost-gate: one more resource in app")" || rc=1
    git -C "$tree" checkout -q main
  fi
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "cost-gate: one more resource in app")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty')"
    cost_gate_holds "$logs" "$note" || rc=1
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "wave 1 waited under gate: never for its +20.00 USD over 15.00 USD, and the plan note set the change against the amount at base"
  return $rc
}

claim_cost/policy() {
  # stack/fixtures/cost-policy: one root, app, with two resources, gate:
  # never, an HCP Terraform policy set (engine: opa, input: hcp) whose
  # mandatory cost_limit policy denies a root whose
  # input.run.cost_estimate.delta_monthly_cost is over 15 and a wave whose
  # input.cost.wave.monthly_delta is, and cost naming cost.mjs, which prices
  # 10.00 a month for each resource a plan creates. The wave exits 1 and
  # applies nothing; the report denies app with both messages, +20.00.
  # BREAK: terragucci.yml has no cost, so the policy reads no cost, denies
  # nothing, and the wave applies.
  log() { echo "[smoke cost-policy] $*" >&2; }
  local work image bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" code=0 rc=0 r q
  image="$(image_tag tofu)"
  docker image inspect "$image" >/dev/null 2>&1 || { log "no CI image $image; run 'just example up' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$HERE/fixtures/cost-policy/." "$work/"
  [ -n "${BREAK:-}" ] || printf 'cost:\n  command: node cost.mjs\n' >> "$work/terragucci.yml"
  git -C "$work" init -q -b main
  git -C "$work" add -A && git -C "$work" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke cost-policy"
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work:/repo" -w /repo \
    -v "$bundle:/usr/local/bin/terragucci:ro" -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$image" terragucci stage tf-apply --wave 1 --layers app --binary tofu --gate never >&2 || code=$?
  clean_mounted "$work" "$image"
  r="$work/terragucci-report/report.json"
  [ "$code" = 1 ] || { log "the wave exited $code, not 1: the cost policy did not deny it"; rc=1; }
  if [ -f "$work/app/terraform.tfstate" ] && jq -e '.resources | length > 0' "$work/app/terraform.tfstate" >/dev/null 2>&1; then
    log "app has state: the wave applied it"; rc=1
  fi
  if [ ! -f "$r" ]; then
    log "the wave wrote no report"; rc=1
  else
    q='.roots[] | select(.path == "app")'
    jq -e "$q | .policy.result == \"denied\" and (.policy.denials | any(test(\"^cost_limit: app adds 20.00 USD a month, over 15.00\"))) and (.policy.denials | any(test(\"^cost_limit: wave 1 adds 20 USD a month, over 15.00\")))" "$r" >/dev/null \
      || { log "app is not denied on its cost and its wave's: $(jq -c "$q | .policy" "$r")"; rc=1; }
    jq -e '.cost.roots[0] | .root == "app" and .monthly_delta == 20' "$r" >/dev/null || { log "the report has no estimate of app at +20.00: $(jq -c '.cost' "$r")"; rc=1; }
  fi
  drop_work "$work" "$image"
  [ $rc = 0 ] && log "the policy set read app's +20.00 from input.run.cost_estimate and the wave's from input.cost, and its mandatory policy denied the wave"
  return $rc
}

claim_refuse/approval_used() {
  # Push the fixture; wave 1 waits. Approve it and push again: canary/one
  # applies, and the wave records on chant/lifecycle that it used the
  # approval. Then change canary/one and push: wave 1 plans another digest,
  # and since the approval it has applied under is used, it waits with the
  # approve command for the new digest instead of refusing.
  # BREAK: the record of the apply is emptied on chant/lifecycle before the
  # change, so the approval reads as one of plans that never applied: stale,
  # and the moved wave is refused.
  log() { echo "[smoke approval-used] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/approval-used" sha applied logs first second clone rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo approval-used || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "approval-used: first")"
  wait_run "$repo" "$sha"
  first="$(run_logs "$repo" "$RUN_ID" | grep -o 'terragucci approve wave-1 --plan [^ ]*' | head -1 | sed 's/.* //' || true)"
  [ -n "$first" ] || { log "wave 1 did not wait with its approve command"; rc=1; }
  if [ $rc = 0 ]; then
    gated_approve approval-used 1 || rc=1
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "approval-used: after wave 1 was approved")"
    wait_run "$repo" "$sha"
    applied="$(gated_applied approval-used)"
    log "after the approval: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$applied" = "canary/one " ] || { log "expected canary/one to apply on the approval"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    clone="$work/lifecycle"
    git clone -q -b chant/lifecycle "${URL/#http:\/\//http://${USER}:${TOKEN}@}/$repo.git" "$clone" || rc=1
  fi
  if [ $rc = 0 ]; then
    jq -e --arg d "$first" 'select(.gate == "wave-1" and .planDigest == $d)' "$clone/_gates/tf-apply/applied.jsonl" >/dev/null 2>&1 \
      || { log "chant/lifecycle holds no record that wave 1 applied under the approval of $first"; rc=1; }
  fi
  if [ $rc = 0 ] && [ -n "${BREAK:-}" ]; then
    : > "$clone/_gates/tf-apply/applied.jsonl"
    git -C "$clone" -c user.name=smoke -c user.email=smoke@terragucci.local -c commit.gpgsign=false commit -q -am "forget the apply" || rc=1
    git -C "$clone" push -q origin chant/lifecycle || rc=1
  fi
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/canary/one/rev.txt"
    sha="$(push_tree "$work/tree" "$repo" main "approval-used: change canary/one after its approved wave applied")"
    wait_run "$repo" "$sha"
    logs="$(run_logs "$repo" "$RUN_ID")"
    second="$(grep -o 'terragucci approve wave-1 --plan [^ ]*' <<<"$logs" | head -1 | sed 's/.* //' || true)"
    log "after the change: run $RUN_STATUS, approve command for ${second:-nothing}"
    grep -qE 'changed after it was approved|planned differently since' <<<"$logs" && { log "wave 1 was refused on the approval it already applied under"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    grep -qE "wave 1 of [0-9]+ waits for an approval of digest $second" <<<"$logs" || { log "wave 1 did not wait for an approval of its new digest"; rc=1; }
    [ -n "$second" ] && [ "$second" != "$first" ] || { log "the approve command names ${second:-no digest}, not a new one"; rc=1; }
    grep -qE "the approval of [^ ]+ by smoke-approver was used by the apply of those plans" <<<"$logs" || { log "the run did not say the earlier approval was used"; rc=1; }
    [ "$(gated_applied approval-used)" = "canary/one " ] || { log "a root applied with nothing approved"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the approval wave 1 applied under refused nothing; the moved wave waits for an approval of $second"
  return $rc
}

# The gated-waves fixture with gate: never and, unless BREAK, the steps given on
# stdin appended to its terragucci.yml, and its pipeline written again.
steps_repo() { # name
  local steps
  steps="$(cat)"
  gated_repo "$1" || return 1
  sed 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" > "$work/terragucci.yml.new" && mv "$work/terragucci.yml.new" "$work/tree/terragucci.yml"
  [ -n "${BREAK:-}" ] || printf '%s\n' "$steps" >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
}

claim_steps/before_plan() {
  # The gated-waves fixture with gate: never. canary/one gains a variable,
  # from_step (default no-step), that a second resource takes as its input,
  # and a step before plan on canary/* writes step.auto.tfvars setting it to
  # the stage the step runs in ($TG_STAGE). The push to main applies every
  # root, canary/one with tf-apply. A pull request that changes canary/one
  # then plans it with the step at the base: the plan note lists the step as
  # passed and the plan moves the input from tf-apply to tf-plan, which only
  # the file the step wrote can say.
  # BREAK: terragucci.yml has no steps, so nothing writes the file and the
  # plan keeps the default.
  log() { echo "[smoke steps-before-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/steps-before-plan" sha head pr note rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  # shellcheck disable=SC2016 # the step's shell expands TG_STAGE
  steps_repo steps-before-plan <<'YAML' || { drop_work "$work"; return 1; }
steps:
  - name: tfvars
    run: echo "from_step = \"$TG_STAGE\"" > step.auto.tfvars
    before: plan
    roots: ["canary/*"]
YAML
  printf '\nvariable "from_step" {\n  type    = string\n  default = "no-step"\n}\n\nresource "terraform_data" "step" {\n  input = var.from_step\n}\n' >> "$work/tree/canary/one/main.tf"
  echo 'step.auto.tfvars' > "$work/tree/.gitignore"
  sha="$(push_tree "$work/tree" "$repo" main "steps-before-plan: a step writes the tfvars")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  [ $rc = 0 ] && [ "$RUN_STATUS" != success ] && { log "the push to main did not apply: $RUN_STATUS"; rc=1; }
  if [ $rc = 0 ]; then
    echo 2 > "$work/tree/canary/one/rev.txt"
    head="$(push_tree "$work/tree" "$repo" change "steps-before-plan: change canary/one")" || rc=1
    git -C "$work/tree" checkout -q main
  fi
  [ $rc = 0 ] && { pr="$(pr_open "$repo" change "steps-before-plan: change canary/one")" || rc=1; }
  [ $rc = 0 ] && { wait_run "$repo" "$head" pull_request || rc=1; }
  if [ $rc = 0 ]; then
    note="$(api "$URL/api/v1/repos/$repo/issues/$pr/comments" | jq -r '[.[] | select(.body | startswith("<!-- terragucci:plan"))] | last | .body // empty')"
    grep -E 'Steps|before-plan|tf-apply|tf-plan' <<<"$note" >&2 || true
    grep -qE '^\| \[?`canary/one`.* \| before-plan \| tfvars \| passed \|$' <<<"$note" || { log "the plan note of pull request $pr does not list the step before plan on canary/one as passed"; rc=1; }
    grep -qE '"tf-apply" -> "tf-plan"' <<<"$note" || { log "the plan of canary/one does not move from_step from tf-apply to tf-plan"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the step before plan wrote step.auto.tfvars, the plan read it, and the plan note listed the step"
  return $rc
}

claim_steps/stop() {
  # The gated-waves fixture with gate: never and a step before apply on
  # canary/* that exits 1. The push to main plans wave 1 (canary/one), the
  # step fails, and the job fails before anything applies: no root has state,
  # and wave 2 never starts. The job log names the failed step.
  # BREAK: terragucci.yml has no steps, so every root applies.
  log() { echo "[smoke steps-stop] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/steps-stop" sha applied rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  steps_repo steps-stop <<'YAML' || { drop_work "$work"; return 1; }
steps:
  - name: stop
    run: echo "this wave stops here"; exit 1
    before: apply
    roots: ["canary/*"]
YAML
  sha="$(push_tree "$work/tree" "$repo" main "steps-stop: a step before apply fails")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  if [ $rc = 0 ]; then
    applied="$(gated_applied steps-stop)"
    log "after the push: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ "$RUN_STATUS" = failure ] || { log "the run did not fail"; rc=1; }
    [ -z "$applied" ] || { log "a root applied although the step before apply failed"; rc=1; }
    run_logs "$repo" "$RUN_ID" | grep -E 'canary/one: before-apply (step )?stop' >&2 || { log "the job log does not name the failed step"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the step before apply failed and nothing applied"
  return $rc
}

claim_steps/gate() {
  # The gated-waves fixture with gate: never and a step after plan on canary/*
  # that exits 1 with on_failure: approve. The push to main stops at wave 1:
  # the step asks for an approval, so the wave waits at its gate and prints
  # the terragucci approve command, and no root has state. That an approval
  # of the held wave's digest then applies it is chant's: the step reaches
  # chant run wave as its after-plan hook with onFailure approve, which
  # op-waves.test.ts holds.
  # BREAK: terragucci.yml has no steps, so the first push applies every root.
  log() { echo "[smoke steps-gate] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/steps-gate" sha applied logs rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  steps_repo steps-gate <<'YAML' || { drop_work "$work"; return 1; }
steps:
  - name: verify
    run: echo "no signature for this module"; exit 1
    after: plan
    roots: ["canary/*"]
    on_failure: approve
YAML
  sha="$(push_tree "$work/tree" "$repo" main "steps-gate: a step asks for an approval")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  if [ $rc = 0 ]; then
    applied="$(gated_applied steps-gate)"
    log "after the first push: run $RUN_STATUS, state for: ${applied:-nothing}"
    [ -z "$applied" ] || { log "a root applied before the wave held by the step was approved"; rc=1; }
    logs="$(run_logs "$repo" "$RUN_ID")"
    grep -E 'step verify asks for an approval|terragucci approve wave-1' <<<"$logs" >&2 || true
    grep -q 'step verify asks for an approval' <<<"$logs" || { log "the log does not say the step verify asks for an approval"; rc=1; }
    grep -qE 'terragucci approve wave-1 --plan (jcs1-)?sha256:[0-9a-f]+' <<<"$logs" || { log "wave 1 gave no approve command"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the step held wave 1 at its gate under gate: never, with the approve command for its digest"
  return $rc
}

# A fresh repo with one root, app, whose terraform_data holds var.greeting and
# whose state is in floci under <name>/, gate: never, and the lines on stdin
# appended to its terragucci.yml; init has written its pipeline.
one_root_repo() { # name
  local name="$1" extra key
  extra="$(cat)"
  fresh_repo "$name" || return 1
  api -o /dev/null -H 'content-type: application/json' -X PATCH -d '{"has_actions":true}' "$URL/api/v1/repos/$USER/$name"
  curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state"
  for key in $(curl -fsS "$FLOCI/shop-terraform-state?list-type=2&prefix=$name/" | grep -o '<Key>[^<]*</Key>' | sed -E 's#</?Key>##g'); do
    curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  done
  mkdir -p "$work/tree/app"
  cat >"$work/tree/app/main.tf" <<HCL
terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "$name/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

variable "greeting" {
  type    = string
  default = "unset"
}

resource "terraform_data" "this" {
  input = var.greeting
}
HCL
  printf 'forge: forgejo\nbinary: tofu\ngate: never\n%s\n' "$extra" > "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
}

claim_init/image() {
  # A one-root repo whose terragucci.yml names image: one built FROM this
  # tree's tofu CI image with a file of its own, /etc/terragucci-smoke-image,
  # and a step before apply that prints it. init writes that image into every
  # job of the pipeline in place of terragucci's; the push to main passes
  # check, the step prints the file in the apply job, and app applies.
  # BREAK: terragucci.yml names no image, so the jobs run in terragucci's,
  # which has no such file: the step fails and app never applies.
  log() { echo "[smoke image] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/image" own="terragucci-smoke-own:$STAMP" mark="own image $STAMP" wf sha logs jobs n m cfg rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  printf 'FROM %s\nRUN echo "%s" > /etc/terragucci-smoke-image\n' "$(image_tag tofu)" "$mark" | docker build -q -t "$own" - >/dev/null \
    || { log "could not build $own"; drop_work "$work"; return 1; }
  cfg="$(printf 'steps:\n  - name: own-image\n    run: cat /etc/terragucci-smoke-image\n    before: apply')"
  [ -n "${BREAK:-}" ] || cfg="$(printf 'image: %s\n%s' "$own" "$cfg")"
  one_root_repo image <<<"$cfg" || { docker rmi -f "$own" >/dev/null 2>&1; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  n="$(grep -c '^    container:' "$wf" || true)"
  m="$(grep -c "image: $own\$" "$wf" || true)"
  log "the pipeline has $n jobs in a container, $m of them in $own"
  if [ -z "${BREAK:-}" ] && { [ "$n" -lt 2 ] || [ "$n" != "$m" ]; }; then log "init did not write $own into every job"; rc=1; fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "image: one root")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  fi
  if [ $rc = 0 ]; then
    jobs="$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs")"
    log "the push ran: $(jq -r '[.[] | "\(.name) \(.status)"] | join(", ")' <<<"$jobs")"
    logs="$(run_logs "$repo" "$RUN_ID")"
    [ "$(jq -r '.[] | select(.name == "check") | .status' <<<"$jobs")" = success ] || { log "check did not pass in $own"; rc=1; }
    grep -qF "$mark" <<<"$logs" || { log "the step did not print the file of $own"; rc=1; }
    [ "$(pr_state_input image app)" = unset ] || { log "app did not apply"; rc=1; }
  fi
  docker rmi -f "$own" >/dev/null 2>&1 || true
  drop_work "$work"
  [ $rc = 0 ] && log "every job ran in $own: check passed, the step printed its file and app applied"
  return $rc
}

claim_init/env() {
  # A one-root repo whose root reads var.greeting, unset by default, and
  # whose terragucci.yml sets env: TF_VAR_greeting. init writes it into the
  # pipeline's env, the push to main applies app, and the state holds the
  # value env gave.
  # BREAK: terragucci.yml sets no env, so app applies with the default.
  log() { echo "[smoke env] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/env" value="from-env-$STAMP" cfg="" sha got rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  [ -n "${BREAK:-}" ] || cfg="$(printf 'env:\n  TF_VAR_greeting: %s' "$value")"
  one_root_repo env <<<"$cfg" || { drop_work "$work"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    grep -qF "TF_VAR_greeting: $value" "$work/tree/.forgejo/workflows/terragucci.yml" || { log "init did not write TF_VAR_greeting into the pipeline"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "env: one root")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    [ "$RUN_STATUS" = success ] || { log "the push ended $RUN_STATUS"; rc=1; }
  fi
  got="$(pr_state_input env app)"
  log "app's state holds ${got:-nothing}"
  [ $rc = 0 ] && { [ "$got" = "$value" ] || { log "app does not hold $value, the value env gave"; rc=1; }; }
  drop_work "$work"
  [ $rc = 0 ] && log "env reached the apply job: app holds $value"
  return $rc
}

# A second forgejo-runner beside the stack's, on its network, that serves one
# label alone. A container of its own, so the stack's runner is never
# reconfigured or restarted; it stays up after the claim, and the next run
# reuses it while Forgejo lists it online. The runner-label claim's serves
# LABELLED_LABEL; replan-cache's serves CACHED_LABEL with the runner's cache
# server on, which the stack's runner keeps off.
LABELLED_LABEL=terragucci-labelled
CACHED_LABEL=terragucci-cached
labelled_runner() { side_runner labelled "$LABELLED_LABEL" false; }
cached_runner() { side_runner cached "$CACHED_LABEL" true; }
side_runner() { # suffix, label, cache enabled -> prints the uuid of a runner online that serves the label alone, starting one when there is none
  local name="${TG_PROJECT:-terragucci}-runner-$1" label="$2" cache="$3" uuid reg token stale i
  uuid="$(api "$URL/api/v1/admin/actions/runners" | jq -r --arg n "$name" 'map(select(.name == $n and .status != "offline")) | .[0].uuid // empty')"
  if [ -n "$uuid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; then echo "$uuid"; return 0; fi
  for stale in $(api "$URL/api/v1/admin/actions/runners" | jq -r --arg n "$name" '.[] | select(.name == $n) | .id'); do
    api -o /dev/null -X DELETE "$URL/api/v1/admin/actions/runners/$stale" || true
  done
  reg="$(jq -n --arg n "$name" --arg l "$label" '{name: $n, description: ("terragucci stack, the runner that serves " + $l + " alone")}' \
    | api -H 'content-type: application/json' -X POST -d @- "$URL/api/v1/admin/actions/runners")" || { log "Forgejo did not register $name"; return 1; }
  uuid="$(jq -r '.uuid // empty' <<<"$reg")"; token="$(jq -r '.token // empty' <<<"$reg")"
  [ -n "$uuid" ] && [ -n "$token" ] || { log "registering $name returned no uuid"; return 1; }
  if ! docker inspect "$name" >/dev/null 2>&1; then
    docker run -d -q --name "$name" --user 0:0 --network "$TG_NETWORK" --restart unless-stopped \
      -v /var/run/docker.sock:/var/run/docker.sock -v "$name-data:/data" -w /data \
      data.forgejo.org/forgejo/runner:13.2.0 \
      sh -c 'while [ ! -s /data/config.yml ]; do sleep 1; done; exec forgejo-runner daemon -c /data/config.yml' >/dev/null || { log "could not start $name"; return 1; }
  else
    docker start "$name" >/dev/null || { log "could not start $name"; return 1; }
  fi
  # The stack runner's config (bootstrap.sh) with one label: the job container's network, cache volume and floci's keys.
  docker exec -i "$name" sh -c 'cat > /data/config.yml.new && mv /data/config.yml.new /data/config.yml' <<EOF || { log "could not write the config of $name"; return 1; }
log:
  level: info
  job_level: info
runner:
  file: /data/.runner
  capacity: 2
  timeout: 30m
  shutdown_timeout: 0s
  fetch_interval: 2s
  report_interval: 1s
  envs:
    TOFU_INSTALL_DIR: /cache/bin
    TF_PLUGIN_CACHE_DIR: /cache
    AWS_ENDPOINT_URL: http://floci:4566
    AWS_ACCESS_KEY_ID: test
    AWS_SECRET_ACCESS_KEY: test
    AWS_REGION: us-east-1
  labels:
    - "$label:docker://public.ecr.aws/docker/library/node:22-bookworm"
cache:
  enabled: $cache
container:
  network: $TG_NETWORK
  privileged: false
  options: "-v $JOB_CACHE_VOLUME:/cache"
  valid_volumes:
    - $JOB_CACHE_VOLUME
  docker_host: "-"
  force_pull: false
server:
  connections:
    forgejo:
      url: http://forgejo:3000/
      uuid: $uuid
      token: $token
EOF
  # Its own container, started on the old credentials when it ran before.
  docker restart "$name" >/dev/null || { log "could not restart $name"; return 1; }
  for i in $(seq 1 60); do
    api "$URL/api/v1/admin/actions/runners" | jq -e --arg u "$uuid" 'map(select(.uuid == $u and .status != "offline")) | length > 0' >/dev/null 2>&1 && { echo "$uuid"; return 0; }
    sleep 2
  done
  docker logs --tail 30 "$name" >&2 2>&1 || true
  log "$name did not come online"
  return 1
}

job_runner() { # repo, run id, job name -> the uuid of the runner that ran the job, from its log's first line
  local id text
  id="$(api "$URL/api/v1/repos/$1/actions/runs/$2/jobs" | jq -r --arg n "$3" 'map(select(.name == $n)) | .[0].id // empty' || true)"
  [ -n "$id" ] || return 0
  text="$(api "$URL/api/v1/repos/$1/actions/jobs/$id/logs" 2>/dev/null || true)"
  sed -nE '1,5s/.*Runner ([0-9a-f-]{36}) .*/\1/p' <<<"$text" | sed -n 1p
}

claim_init/runner_label() {
  # A one-root repo whose terragucci.yml sets runner.apply to a label that
  # only a second Forgejo runner serves (labelled_runner). init writes that
  # label as the runs-on of the apply jobs and leaves the others on the
  # default; the push to main runs check on the stack's runner and
  # apply-wave-1 on the labelled one, and app applies.
  # BREAK: terragucci.yml sets no runner, so init renders the default label
  # and apply-wave-1 runs on the stack's runner.
  log() { echo "[smoke runner-label] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/runner-label" cfg="" uuid sha applied checked rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  uuid="$(labelled_runner)" || { drop_work "$work"; return 1; }
  log "runner $uuid serves $LABELLED_LABEL alone"
  [ -n "${BREAK:-}" ] || cfg="$(printf 'runner:\n  apply: %s' "$LABELLED_LABEL")"
  one_root_repo runner-label <<<"$cfg" || { drop_work "$work"; return 1; }
  if [ -z "${BREAK:-}" ]; then
    grep -qx "    runs-on: $LABELLED_LABEL" "$work/tree/.forgejo/workflows/terragucci.yml" || { log "init did not write runs-on: $LABELLED_LABEL"; rc=1; }
    grep -qx "    runs-on: docker" "$work/tree/.forgejo/workflows/terragucci.yml" || { log "no job is left on the default label"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "runner-label: one root")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    [ $rc = 0 ] && [ "$RUN_STATUS" != success ] && { print_logs "$repo" "$RUN_ID" >&2; log "the push ended $RUN_STATUS"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    applied="$(job_runner "$repo" "$RUN_ID" apply-wave-1)"
    checked="$(job_runner "$repo" "$RUN_ID" check)"
    log "check ran on ${checked:-no runner}, apply-wave-1 on ${applied:-no runner}"
    [ "$applied" = "$uuid" ] || { log "apply-wave-1 did not run on the runner that serves $LABELLED_LABEL"; rc=1; }
    [ -n "$checked" ] && [ "$checked" != "$uuid" ] || { log "check did not run on the stack's runner"; rc=1; }
    [ "$(pr_state_input runner-label app)" = unset ] || { log "app has no state from the apply"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "apply-wave-1 ran on the runner serving $LABELLED_LABEL, and check on the stack's"
  return $rc
}

claim_init/pass_secrets() {
  # A one-root repo whose root reads var.greeting and var.place, with a repo
  # secret TF_VAR_greeting and a repo variable TF_VAR_place, both named under
  # pass in terragucci.yml. init writes the names, never the values, into the
  # jobs that plan and apply; the push to main applies app, and its state
  # holds both values. Forgejo keeps each name in capitals, and the job reads
  # it as the root spells it.
  # BREAK: terragucci.yml has no pass, so app applies with both defaults.
  log() { echo "[smoke pass-secrets] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/pass-secrets" word="secret-$STAMP" place="var-$STAMP" cfg="" sha got wf rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  [ -n "${BREAK:-}" ] || cfg="$(printf 'pass:\n  secrets: [TF_VAR_greeting]\n  vars: [TF_VAR_place]')"
  one_root_repo pass-secrets <<<"$cfg" || { drop_work "$work"; return 1; }
  perl -0pi -e 's/  input = var\.greeting\n/  input = "\${var.greeting}\@\${var.place}"\n/; s/\z/\nvariable "place" {\n  type    = string\n  default = "unset"\n}\n/' "$work/tree/app/main.tf"
  grep -qF 'input = "${var.greeting}@${var.place}"' "$work/tree/app/main.tf" || { log "the root does not read var.place"; drop_work "$work"; return 1; }
  jq -n --arg d "$word" '{data: $d}' | api -o /dev/null -H 'content-type: application/json' -X PUT -d @- "$URL/api/v1/repos/$repo/actions/secrets/TF_VAR_greeting" \
    || { log "could not set the TF_VAR_greeting secret"; drop_work "$work"; return 1; }
  jq -n --arg v "$place" '{value: $v}' | api -o /dev/null -H 'content-type: application/json' -X POST -d @- "$URL/api/v1/repos/$repo/actions/variables/TF_VAR_place" \
    || { log "could not set the TF_VAR_place variable"; drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  if [ -z "${BREAK:-}" ]; then
    grep -qF "TF_VAR_greeting: '\${{ secrets.TF_VAR_greeting }}'" "$wf" && grep -qF "TF_VAR_place: '\${{ vars.TF_VAR_place }}'" "$wf" || { log "init did not write both names into the pipeline"; rc=1; }
  fi
  grep -qF -e "$word" -e "$place" "$wf" && { log "a value is in the pipeline"; rc=1; }
  if [ $rc = 0 ]; then
    sha="$(push_tree "$work/tree" "$repo" main "pass-secrets: one root")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
    [ $rc = 0 ] && [ "$RUN_STATUS" != success ] && { print_logs "$repo" "$RUN_ID" >&2; log "the push ended $RUN_STATUS"; rc=1; }
  fi
  got="$(pr_state_input pass-secrets app)"
  log "app's state holds ${got:-nothing}"
  [ $rc = 0 ] && { [ "$got" = "$word@$place" ] || { log "app does not hold the secret's and the variable's values"; rc=1; }; }
  drop_work "$work"
  [ $rc = 0 ] && log "the secret and the variable reached the apply job by name: app holds both values"
  return $rc
}

claim_estate/local_plan() {
  # terragucci plan, run as on a laptop: in a copy of the example with the
  # one-root change (dev orders keeps jobs for seven days), from the tofu CI
  # image with floci's keys, and --json. Each dev root plans against the
  # state the example applied: dev orders plans one change, the other four
  # plan none, and the envelope says exit 0 with all five.
  # BREAK: the change is left out, so dev orders plans none.
  log() { echo "[smoke local-plan] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work out code=0 rc=0 got
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  cp -R "$EXAMPLE/." "$work/"
  [ -n "${BREAK:-}" ] || git -C "$work" apply "$EXAMPLE/changes/one-root.patch" 2>/dev/null || (cd "$work" && patch -s -p1 <"$EXAMPLE/changes/one-root.patch") || { log "the one-root change does not apply"; drop_work "$work"; return 1; }
  # Other claims plan the example too; a state lock one of them holds is waited for, as a person would.
  local -a AWS_DOCKER_ENV=("${AWS_DOCKER_ENV[@]}" -e TF_CLI_ARGS_plan=-lock-timeout=180s)
  out="$(in_image "$work" terragucci plan --root 'envs/dev/*' --json 2>"$work.err")" || code=$?
  log "terragucci plan exited $code: $(jq -c '[.results.roots[]? | "\(.root): \(.summary)"]' <<<"$out" 2>/dev/null || echo "$out" | tail -3)"
  if [ "$code" != 0 ]; then
    tail -20 "$work.err" >&2
    # --json keeps a failed root's output out of the envelope; the text form says why.
    in_image "$work" terragucci plan --root 'envs/dev/*' 2>&1 | grep -v '^\s*$' | tail -30 >&2 || true
    log "terragucci plan exited $code, not 0"; rc=1
  fi
  got="$(jq -r '.results.roots | map(select(.ok)) | map(.root) | sort | join(",")' <<<"$out" 2>/dev/null || true)"
  [ "$got" = "envs/dev/email,envs/dev/orders,envs/dev/payments,envs/dev/platform,envs/dev/search" ] || { log "the planned roots are ${got:-none}, not the five dev roots"; rc=1; }
  [ "$(jq -r '.results.roots[] | select(.root == "envs/dev/orders") | .summary' <<<"$out" 2>/dev/null)" = "Plan: 0 to add, 1 to change, 0 to destroy." ] || { log "dev orders did not plan its one change"; rc=1; }
  [ "$(jq -r '[.results.roots[] | select(.root != "envs/dev/orders") | .summary] | unique | join(",")' <<<"$out" 2>/dev/null)" = "No changes. Your infrastructure matches the configuration." ] || { log "a dev root other than orders planned a change"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "dev orders planned its one change against the applied state, and the other four none"
  return $rc
}

# The Terragrunt gated-waves fixture (live/canary/one, then live/fleet/three and
# live/fleet/two) in a fresh repo, with gate: never and, unless BREAK, the lines
# given on stdin appended to its terragucci.yml, and its pipeline written again.
tg_never_repo() { # name
  local extra
  extra="$(cat)"
  gated_repo "$1" tg-gated-waves || return 1
  sed 's/^gate: always$/gate: never/' "$work/tree/terragucci.yml" > "$work/terragucci.yml.new" && mv "$work/terragucci.yml.new" "$work/tree/terragucci.yml"
  [ -n "${BREAK:-}" ] || printf '%s\n' "$extra" >> "$work/tree/terragucci.yml"
  (cd "$work/tree" && "$TERRAGUCCI" init >/dev/null) || { log "init failed"; return 1; }
}

claim_respond/terragrunt_fmt() {
  # The Terragrunt gated-waves fixture: main is pushed without a run, then a
  # branch whose live/canary/one/terragrunt.hcl is not formatted. The branch's
  # check fails on terragrunt hcl fmt --check, and the pipeline's fmt job runs
  # terragrunt hcl fmt and pushes one commit, style: terragrunt hcl fmt, to the
  # branch, with the file formatted; main does not move.
  # BREAK: the fmt job runs respond fmt in dry-run mode, which commits nothing.
  log() { echo "[smoke tg-respond-fmt] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tg-respond-fmt" wf main_sha sha head branch_head subject file rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  gated_repo tg-respond-fmt tg-gated-waves || { drop_work "$work"; return 1; }
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q '^  fmt:' "$wf" || { log "init wrote no fmt job for a Terragrunt repo"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    sed 's#respond fmt --mode apply#respond fmt --mode dry-run#' "$wf" > "$wf.new" && mv "$wf.new" "$wf"
  fi
  main_sha="$(push_tree "$work/tree" "$repo" main "tg-respond-fmt: formatted [skip ci]")" || { drop_work "$work"; return 1; }
  perl -0pi -e 's/inputs = \{\n  rev =/inputs = {\n      rev     =/' "$work/tree/live/canary/one/terragrunt.hcl"
  grep -q '^      rev     =' "$work/tree/live/canary/one/terragrunt.hcl" || { log "could not unformat the unit"; drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" smoke-fmt "tg-respond-fmt: unformatted")" || rc=1
  [ $rc = 0 ] && { wait_run "$repo" "$sha" || rc=1; }
  # The run reads as failed once its check fails, while the fmt job after it may still be running: wait for that job.
  if [ $rc = 0 ]; then
    for _ in $(seq 1 100); do
      case "$(api "$URL/api/v1/repos/$repo/actions/runs/$RUN_ID/jobs" | jq -r '[.[] | select(.name == "fmt")][0].status // "missing"')" in
        success|failure|cancelled|skipped|missing) break ;;
      esac
      sleep 3
    done
    run_logs "$repo" "$RUN_ID" | grep -E 'hcl fmt|committed|would commit|already formatted' | tail -6 >&2 || true
    branch_head="$(remote_head "$repo" smoke-fmt)"
    head="$(remote_head "$repo" main)"
    log "after the branch's run ($RUN_STATUS): smoke-fmt at ${branch_head:0:8}, pushed ${sha:0:8}"
    [ -n "$branch_head" ] && [ "$branch_head" != "$sha" ] || { log "the fmt job pushed no commit to smoke-fmt"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    subject="$(api "$URL/api/v1/repos/$repo/git/commits/$branch_head?stat=false&files=false&verification=false" | jq -r '.commit.message' | head -1)"
    [ "$subject" = "style: terragrunt hcl fmt" ] || { log "the branch's last commit is '$subject'"; rc=1; }
    file="$(file_at "$repo" smoke-fmt "$branch_head" live/canary/one/terragrunt.hcl)"
    grep -q '^  rev = ' <<<"$file" || { log "live/canary/one/terragrunt.hcl is not formatted on the branch"; rc=1; }
    [ "$head" = "$main_sha" ] || { log "main moved"; rc=1; }
  fi
  drop_work "$work"
  [ $rc = 0 ] && log "the fmt job pushed one terragrunt hcl fmt commit to smoke-fmt; main untouched"
  return $rc
}

# ── a state lock a killed apply left ──────────────────────────────────────

unlock_in() { # dir, bundle, command... -> runs it in the CI image in DIR, with the forge token as FORGEJO_TOKEN
  local dir="$1" bundle="$2"; shift 2
  run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$dir:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
    -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache "${AWS_DOCKER_ENV[@]}" \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e FORGEJO_TOKEN="$TOKEN" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$(image_tag "$SMOKE_BINARY")" "$@"
}

unlock_live() {
  # SMOKE_BINARY=choudoufu: one estate under live resource markers, first and
  # second, second depending on first and whose provisioner leaves a mark and
  # then sleeps. A tf-apply wave in the choudoufu CI image is killed once the
  # mark is there, as a runner kills a job mid-apply. The record store must
  # then hold first's record and no lock object, and terragucci unlock-state
  # estate must exit 0 saying there is no state file and no state lock, with
  # nothing to release and no approval asked for. tf-plan then plans second
  # as a create, with nothing released.
  # BREAK: the root keeps an s3 backend with use_lockfile (choudoufu without
  # live markers), so the killed apply leaves its lock file behind and
  # unlock-state finds a lock to release.
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work estate pid i keys held out code=0 got rc=0 lockobj=""
  docker image inspect "$(image_tag choudoufu)" >/dev/null 2>&1 || { log "no CI image $(image_tag choudoufu); run 'just images' first"; return 1; }
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  estate="smoke-unlock-live-$(date +%s)-$$"
  cdf_bucket || { log "could not set up the record store bucket $CDF_RECORDS"; drop_work "$work"; return 1; }
  cdf_proxy_up "$work" || { log "the record store proxy did not start"; cdf_down "$work"; return 1; }
  rows_estate "$work/a" "$estate" "$(cat <<'HCL'
resource "terraform_data" "first" {
  input = "first"
}

resource "terraform_data" "second" {
  input      = "second"
  depends_on = [terraform_data.first]

  provisioner "local-exec" {
    command = "touch /repo/second-started && sleep 900"
  }
}
HCL
)"
  if [ -n "${BREAK:-}" ]; then
    lockobj="unlock-live/$estate.tfstate.tflock"
    curl -fsS -o /dev/null -X PUT "$FLOCI/shop-terraform-state" || true
    perl -0pi -e 's#  live \{.*?\n  \}\n#  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "unlock-live/'"$estate"'.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n#s' "$work/a/estate/main.tf"
    grep -q 'backend "s3"' "$work/a/estate/main.tf" || { log "could not give the root an s3 backend, so BREAK proves nothing"; cdf_down "$work"; return 0; }
  fi
  printf 'second-started\n' >>"$work/a/.gitignore"
  git -C "$work/a" init -q -b main && git -C "$work/a" add -A && git -C "$work/a" -c user.name=smoke -c user.email=smoke@localhost -c commit.gpgsign=false commit -qm "smoke estate" \
    || { log "could not commit the estate"; cdf_down "$work"; return 1; }
  ( cdf_run "$work/a" "$work/apply.log" "$CDF_ALIAS-apply" choudoufu "" tf-apply --wave 1 --layers estate --binary choudoufu --gate never ) >/dev/null 2>&1 &
  pid=$!
  started() { docker exec "$CDF_ALIAS-apply" test -e /repo/second-started >/dev/null 2>&1; }
  for i in $(seq 1 180); do started && break; kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if ! started; then
    log "second's provisioner never started"; tail -20 "$work/apply.log" >&2
    docker rm -f "$CDF_ALIAS-apply" >/dev/null 2>&1 || true; wait "$pid" 2>/dev/null || true; cdf_down "$work"; return 1
  fi
  docker kill "$CDF_ALIAS-apply" >/dev/null 2>&1 || true
  wait "$pid" 2>/dev/null || true
  log "the wave was killed mid-apply, while second's provisioner ran"
  if [ -n "$lockobj" ]; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$FLOCI/shop-terraform-state/$lockobj")" != 200 ] || { log "the killed apply left its lock file s3://shop-terraform-state/$lockobj"; rc=1; }
  else
    keys="$(cdf_keys "$estate")"
    log "records after the kill: $(grep '/terraform_data/' <<<"$keys" | jq -Rr 'split("/") | last | (try @base64d catch .)' | tr '\n' ' ')"
    grep '/terraform_data/' <<<"$keys" | jq -Rr 'split("/") | last | (try @base64d catch .)' | grep -q first || { log "the killed wave left no record for terraform_data.first"; rc=1; }
    held="$(sed "s#^tofu-records/$estate/##" <<<"$keys" | grep -iE '(^|/)[^/]*lock[^/]*$' || true)"
    [ -z "$held" ] || { log "the record store holds a lock object: $(head -3 <<<"$held" | tr '\n' ' ')"; rc=1; }
  fi
  out="$(run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$work/a:/repo" -w /repo -v "$HERE/../packages/terragucci/dist/terragucci.mjs:/usr/local/bin/terragucci:ro" \
    -e "AWS_ENDPOINT_URL=http://$CDF_ALIAS:4566" -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 \
    -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$(image_tag choudoufu)" terragucci unlock-state estate --binary choudoufu --actor smoke-operator 2>&1)" || code=$?
  clean_mounted "$work/a"
  printf '%s\n' "$out" | sed 's/^/  /' >&2
  [ "$code" = 0 ] || { log "unlock-state exited $code, not 0"; rc=1; }
  grep -q "no state file and no state lock; nothing to release" <<<"$out" || { log "unlock-state does not say there is no state lock to release"; rc=1; }
  ! grep -q "terragucci approve unlock" <<<"$out" || { log "unlock-state asked for an approval"; rc=1; }
  if [ $rc = 0 ]; then
    if ! cdf_run "$work/a" "$work/plan.log" "$CDF_ALIAS-plan" choudoufu "" tf-plan --binary choudoufu; then
      log "tf-plan after the kill failed"; tail -20 "$work/plan.log" >&2; rc=1
    else
      got="$(jq -r '[.roots[] | select(.path == "estate") | .changes[] | "\(.address)=\(.action)"] | sort | join(" ")' "$work/a/terragucci-report/report.json" 2>/dev/null || echo none)"
      log "the plan after the kill: ${got:-no change}"
      grep -q 'terraform_data.second=create' <<<"$got" || { log "the plan after the kill does not create terraform_data.second"; rc=1; }
    fi
  fi
  [ -z "$lockobj" ] || curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$lockobj" || true
  cdf_down "$work"
  [ $rc = 0 ] && log "the killed apply left first's record and no lock; unlock-state found nothing to release, asked no approval, and the next plan creates second"
  return $rc
}

claim_state/unlock() {
  # stack/fixtures/unlock-state: one root, slow, whose terraform_data runs a
  # local-exec that sleeps for the seconds in hold.txt (600) while its apply
  # holds slow's lock file in floci, gate: never. A push to main runs its
  # wave. While that apply holds the lock and its run is going, terragucci
  # unlock-state slow (in the CI image, from a clone, with the forge token)
  # must refuse, naming the run, and leave the lock. The apply's job
  # container is then killed. Once the run has ended, unlock-state waits for
  # an approval (exit 3) and leaves the lock; smoke-approver approves the
  # digest it printed with chant approve tf-unlock, and unlock-state then
  # releases the lock, and _gates/tf-unlock/done.jsonl on chant/lifecycle
  # names the lock's ID, the approver and who released it. A push that sets
  # hold.txt to 0 then applies.
  # BREAK: the bundle unlock-state runs asks the forge for no run states, so
  # its liveness check passes while the apply is still running: approved, it
  # frees the lock the running job holds, and the claim catches the lock gone
  # while the run is alive.
  # Under SMOKE_BINARY=terraform the root and its jobs are Terraform's; under
  # choudoufu the root is under live resource markers: unlock_live.
  log() { echo "[smoke unlock-state] $*" >&2; }
  [ "$SMOKE_BINARY" != choudoufu ] || { unlock_live; return; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local name=unlock-state work repo="$USER/unlock-state" bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" sha run="" status="" lock id="" out code digest done i job task rc=0
  local inner="http://${USER}:${TOKEN}@forgejo:3000/$USER/unlock-state.git" host="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$USER/unlock-state.git"
  lock="$FLOCI/shop-terraform-state/$name/slow.tfstate.tflock"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  build_cli || return 1
  if [ -n "${BREAK:-}" ]; then
    # Cut the liveness check: the run states it asks Forgejo for become none.
    [ "$(grep -o '\["running","waiting","blocked"\]' "$bundle" | wc -l | tr -d ' ')" = 1 ] || { log "the bundle has no single list of live run states to cut, so BREAK proves nothing"; drop_work "$work"; return 0; }
    sed 's/\["running","waiting","blocked"\]/[]/' "$bundle" > "$work/terragucci.mjs" && chmod +x "$work/terragucci.mjs"
    bundle="$work/terragucci.mjs"
  fi
  gated_repo "$name" unlock-state || { drop_work "$work"; return 1; }
  sha="$(push_tree "$work/tree" "$repo" main "unlock-state: slow sleeps 600s")" || { drop_work "$work"; return 1; }
  # The kill and the end of the run, whatever happens: a job left sleeping holds a runner slot for ten minutes.
  kill_apply() {
    [ -n "$run" ] || return 0
    for job in $(api "$URL/api/v1/repos/$repo/actions/runs/$run/jobs" 2>/dev/null | jq -r '.[] | select(.status == "running") | .task_id'); do
      for task in $(docker ps -q --filter "name=FORGEJO-ACTIONS-TASK-${job}_"); do docker kill "$task" >/dev/null 2>&1 || true; done
    done
  }
  run_status() { api "$URL/api/v1/repos/$repo/actions/runs/$run" 2>/dev/null | jq -r '.status // empty'; }
  # Wait for the apply to take the lock while its run is going.
  for i in $(seq 1 120); do
    [ -n "$run" ] || run="$(api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$sha" | jq -r '.workflow_runs[0].id // empty')"
    status="$( [ -n "$run" ] && run_status)"
    case "$status" in success|failure|cancelled|skipped) break ;; esac
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$lock")" = 200 ] && [ "$status" = running ] && break
    sleep 5
  done
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$lock")" != 200 ] || [ "$status" != running ]; then
    log "the apply never held slow's lock in a running run (run ${run:-none}: ${status:-no status})"
    [ -n "$run" ] && print_logs "$repo" "$run" | tail -40 >&2
    kill_apply; drop_work "$work"; return 1
  fi
  id="$(curl -fsS "$lock" | jq -r '.ID')"
  log "run $run is applying and holds lock $id"
  git clone -q "$host" "$work/clone" && git -C "$work/clone" remote set-url origin "$inner" || { kill_apply; drop_work "$work"; return 1; }
  # 1. While the run is going: refused, the lock left. Under BREAK it waits for an approval instead.
  code=0; out="$(unlock_in "$work/clone" "$bundle" terragucci unlock-state slow --actor smoke-operator 2>&1)" || code=$?
  printf '%s\n' "$out" >&2
  clean_mounted "$work/clone"
  if [ -n "${BREAK:-}" ]; then
    digest="$(sed -n 's/.*terragucci approve unlock slow --plan \([^ ]*\).*/\1/p' <<<"$out" | head -1)"
    if [ "$code" != 3 ] || [ -z "$digest" ]; then log "unlock-state exited $code without an approval to wait for, so BREAK proves nothing"; kill_apply; drop_work "$work"; return 0; fi
    git clone -q "$host" "$work/approver-clone" && git -C "$work/approver-clone" config user.name smoke-approver && git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    (cd "$work/approver-clone" && "$CHANT" approve tf-unlock slow --plan "$digest" --approver smoke-approver) >&2 || { log "chant approve failed, so BREAK proves nothing"; kill_apply; drop_work "$work"; return 0; }
    code=0; out="$(unlock_in "$work/clone" "$bundle" terragucci unlock-state slow --actor smoke-operator 2>&1)" || code=$?
    printf '%s\n' "$out" >&2
    clean_mounted "$work/clone"
    status="$(run_status)"
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$lock")" = 404 ] && [ "$status" = running ]; then
      log "lock $id was freed while run $run, which holds it, is still running"; rc=1
    else
      log "the lock is $(curl -s -o /dev/null -w '%{http_code}' "$lock") and run $run is $status, so BREAK proves nothing"
    fi
    kill_apply; drop_work "$work"; return $rc
  fi
  [ "$code" = 1 ] && grep -q "run $run (running" <<<"$out" || { log "unlock-state exited $code and did not refuse for run $run"; rc=1; }
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$lock")" = 200 ] || { log "the lock is gone while run $run holds it"; rc=1; }
  # 2. The apply is killed mid-run; the lock stays.
  kill_apply
  for i in $(seq 1 60); do status="$(run_status)"; case "$status" in success|failure|cancelled|skipped) break ;; esac; sleep 3; done
  log "after the kill, run $run is $status"
  case "$status" in failure|cancelled) ;; *) log "run $run did not end after its apply was killed"; rc=1 ;; esac
  [ $rc = 0 ] && { [ "$(curl -s -o /dev/null -w '%{http_code}' "$lock")" = 200 ] || { log "the killed apply left no lock to release"; rc=1; }; }
  # 3. No run alive: it waits for an approval, and the lock stays until then.
  if [ $rc = 0 ]; then
    code=0; out="$(unlock_in "$work/clone" "$bundle" terragucci unlock-state slow --actor smoke-operator 2>&1)" || code=$?
    printf '%s\n' "$out" >&2
    clean_mounted "$work/clone"
    digest="$(sed -n 's/.*terragucci approve unlock slow --plan \([^ ]*\).*/\1/p' <<<"$out" | head -1)"
    [ "$code" = 3 ] && [ -n "$digest" ] || { log "unlock-state exited $code and printed no approval to wait for"; rc=1; }
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$lock")" = 200 ] || { log "the lock was freed before any approval"; rc=1; }
  fi
  # 4. Approved: released, and recorded.
  if [ $rc = 0 ]; then
    git clone -q "$host" "$work/approver-clone" && git -C "$work/approver-clone" config user.name smoke-approver && git -C "$work/approver-clone" config user.email smoke-approver@terragucci.local
    (cd "$work/approver-clone" && "$CHANT" approve tf-unlock slow --plan "$digest" --approver smoke-approver) >&2 || { log "chant approve tf-unlock failed"; rc=1; }
  fi
  if [ $rc = 0 ]; then
    code=0; out="$(unlock_in "$work/clone" "$bundle" terragucci unlock-state slow --actor smoke-operator 2>&1)" || code=$?
    printf '%s\n' "$out" >&2
    clean_mounted "$work/clone"
    [ "$code" = 0 ] || { log "unlock-state exited $code after the approval"; rc=1; }
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$lock")" = 404 ] || { log "the lock is still held after the approved release"; rc=1; }
    git clone -q -b chant/lifecycle "$host" "$work/ledger" 2>/dev/null || true
    done="$(cat "$work/ledger/_gates/tf-unlock/done.jsonl" 2>/dev/null)"
    [ "$(jq -r 'select(.gate == "slow") | [.lock.ID, .approvedBy, .releasedBy, .planDigest] | join(" ")' <<<"$done" 2>/dev/null)" = "$id smoke-approver smoke-operator $digest" ] \
      || { log "done.jsonl does not record lock $id released by smoke-operator under smoke-approver's approval: $done"; rc=1; }
  fi
  # 5. The next wave applies.
  if [ $rc = 0 ]; then
    echo 0 > "$work/tree/slow/hold.txt"
    sha="$(push_tree "$work/tree" "$repo" main "unlock-state: slow sleeps 0s")" || rc=1
    [ $rc = 0 ] && { wait_run "$repo" "$sha" push || rc=1; }
    [ $rc = 0 ] && [ "$RUN_STATUS" = success ] || { log "the next run ended ${RUN_STATUS:-unknown}"; [ -n "${RUN_ID:-}" ] && print_logs "$repo" "$RUN_ID" | tail -40 >&2; rc=1; }
    [ $rc = 0 ] && { [ "$(curl -fsS "$FLOCI/shop-terraform-state/$name/slow.tfstate" | jq -r '[.resources[].instances[].attributes.input | .value? // .] | map(tostring) | join(",")')" = 0 ] || { log "slow's state does not hold the applied resource"; rc=1; }; }
  fi
  kill_apply
  drop_work "$work"
  [ $rc = 0 ] && log "unlock-state refused while run $run held lock $id, waited for its approval once the killed run ended, released it, recorded it, and the next wave applied"
  return $rc
}

# ── a rename's moved block ────────────────────────────────────────────────

claim_tips/moved() {
  # A root, app, holding terraform_data.old is applied, its state in floci.
  # On a branch, rename, the block is renamed new with the same input:
  # stage tf-plan plans a destroy and a create, and its report carries the
  # terragucci-moved tip for app. respond tips --report --branch rename then
  # opens a pull request into rename that adds the moved block to
  # app/main.tf; merged, stage tf-plan of rename plans a move of
  # terraform_data.old to terraform_data.new and destroys nothing.
  # BREAK: respond.tips is off, so no pull request opens and rename's plan
  # still destroys terraform_data.old.
  # Under SMOKE_BINARY the tree is written for that binary (binary-tree.py:
  # under choudoufu the s3 backend becomes a live block and the root an
  # estate) and every run is in its CI image.
  log() { echo "[smoke tip-moved] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/tip-moved" tree out pr base files plan rc=0 IN_IMAGE
  IN_IMAGE="$(bin_image)"
  local host="${URL/#http:\/\//http://${USER}:${TOKEN}@}/$USER/tip-moved.git"
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo tip-moved || return 1
  tree="$work/tree"
  mkdir -p "$tree/app"
  printf 'terraform {\n  backend "s3" {\n    bucket         = "shop-terraform-state"\n    key            = "tip-moved/%s/app.tfstate"\n    region         = "us-east-1"\n    use_lockfile   = true\n    use_path_style = true\n  }\n}\n\nresource "terraform_data" "old" {\n  input = "tip-moved-%s"\n}\n' "$STAMP" "$STAMP" > "$tree/app/main.tf"
  printf 'binary: tofu\nforge: forgejo\nurl: http://forgejo:3000/%s\ntoken_env: TERRAGUCCI_FORGEJO_TOKEN\n' "$repo" > "$tree/terragucci.yml"
  [ -n "${BREAK:-}" ] && printf 'respond:\n  tips: off\n' >> "$tree/terragucci.yml"
  printf 'terragucci-report*/\n.terraform/\n.tofu-records/\n' > "$tree/.gitignore"
  bin_prepare && bin_tree "$tree" "tip-moved-$(date +%s)" || { log "the tree was not written for $SMOKE_BINARY"; drop_work "$work"; return 1; }
  git -C "$tree" init -q -b main
  git -C "$tree" remote add origin "http://$USER:$TOKEN@forgejo:3000/$repo.git"
  push_tree "$tree" "$repo" main "terraform_data.old" >/dev/null || { drop_work "$work"; return 1; }
  in_image "$tree" sh -c "cd app && $SMOKE_BINARY init -input=false -no-color >/dev/null && $SMOKE_BINARY apply -auto-approve -input=false -no-color >/dev/null" >&2 || { log "the first apply failed"; drop_work "$work"; return 1; }
  perl -pi -e 's/"terraform_data" "old"/"terraform_data" "new"/' "$tree/app/main.tf"
  push_tree "$tree" "$repo" rename "rename terraform_data.old to new" >/dev/null || { drop_work "$work"; return 1; }
  out="$(in_image "$tree" sh -c "terragucci stage tf-plan --binary $SMOKE_BINARY --out terragucci-report >/dev/null 2>&1; terragucci respond tips --mode apply --report terragucci-report --branch rename" 2>&1)" || true
  printf '%s\n' "$out" >&2
  clean_mounted "$tree"
  jq -e '[.tips[]? | select(.rule == "terragucci-moved" and .root == "app")] | length == 1' "$tree/terragucci-report/report.json" >/dev/null \
    || { log "the plan's report has no terragucci-moved tip for app"; rc=1; }
  [ "$(jq '[.resource_changes[] | select(.change.actions == ["delete"])] | length' "$tree/terragucci-report/roots/app/plan.json")" = 1 ] \
    || { log "the plan of the rename does not destroy terraform_data.old"; rc=1; }
  [ $rc = 0 ] || { drop_work "$work"; return 1; }
  pr="$(open_pr "$repo" terragucci/tip/moved-app)"
  if [ -n "$pr" ]; then
    base="$(api "$URL/api/v1/repos/$repo/pulls/$pr" | jq -r '.base.ref')"
    files="$(pr_files "$repo" "$pr")"
    [ "$base" = rename ] && [ "$files" = app/main.tf ] || { log "pull request $pr goes into $base and changes $files, not rename and app/main.tf"; drop_work "$work"; return 1; }
    merge_pr "$repo" "$pr" || { log "could not merge pull request $pr"; drop_work "$work"; return 1; }
    log "merged pull request $pr into rename"
  else
    log "no pull request from terragucci/tip/moved-app"
  fi
  git -C "$tree" fetch -q "$host" rename && git -C "$tree" checkout -q -B rename FETCH_HEAD || { drop_work "$work"; return 1; }
  in_image "$tree" terragucci stage tf-plan --binary "$SMOKE_BINARY" --out terragucci-report-merged >/dev/null 2>&1 || true
  clean_mounted "$tree"
  plan="$tree/terragucci-report-merged/roots/app/plan.json"
  [ -f "$plan" ] || { log "the plan of rename wrote no plan"; drop_work "$work"; return 1; }
  if [ "$(jq '[.resource_changes[] | select(.change.actions | index("delete"))] | length' "$plan")" != 0 ]; then
    log "the plan of rename still destroys: $(jq -c '[.resource_changes[] | {address, actions: .change.actions}]' "$plan")"; rc=1
  fi
  [ "$(jq -r '[.resource_changes[] | select(.address == "terraform_data.new" and .previous_address == "terraform_data.old" and .change.actions == ["no-op"])] | length' "$plan")" = 1 ] \
    || { log "the plan of rename does not move terraform_data.old to terraform_data.new"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the tip's pull request $pr added the moved block, and rename now plans a move with no destroy"
  return $rc
}

claim_lock/plan_fmt() {
  # On the lock-plan setup (locks: plan). Pull request A changes canary/one
  # and holds it. Then an unformatted main.tf is pushed to its branch: the
  # check fails, and
  # the fmt job commits the formatting with the job's token, a push that
  # starts no run, so no pr-lock run sees the formatted head. The fmt job then
  # answers the lock itself: terragucci/lock on the formatted head is success,
  # holding canary/one (and the roots its main.tf reaches), and A holds
  # canary/one at that head.
  # BREAK: the fmt job's lock step is cut from the pushed pipeline, so the
  # formatted head is never answered. The cut pipeline is pushed to a repo of
  # its own, plan-lock-fmt.
  log() { echo "[smoke lock/plan-fmt] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo wf head_a head_u head_f="" pr_a got i rc=0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    repo="$USER/plan-lock-fmt"
    plan_lock_repo plan-lock-fmt || { drop_work "$work"; return 1; }
  else
    repo="$USER/lock-plan"
    setup_shared lock-plan lock_plan_make || { drop_work "$work"; return 1; }
  fi
  wf="$work/tree/.forgejo/workflows/terragucci.yml"
  grep -q "Lock the roots the pull request's new head reaches" "$wf" || { log "init wrote no lock step in the fmt job"; drop_work "$work"; return 1; }
  if [ -n "${BREAK:-}" ]; then
    perl -0pi -e "s/\n      - name: Lock the roots the pull request's new head reaches\n.*?\n(?=  \S|      - )/\n/s" "$wf"
    ! grep -q "new head reaches" "$wf" || { log "the BREAK did not cut the lock step"; drop_work "$work"; return 1; }
    wait_run "$repo" "$(push_tree "$work/tree" "$repo" main "plan-lock-fmt: first")" || { drop_work "$work"; return 1; }
  fi
  echo fmt > "$work/tree/canary/one/rev.txt"
  head_a="$(push_tree "$work/tree" "$repo" fmt-a "lock/plan-fmt: a")" || { drop_work "$work"; return 1; }
  pr_a="$(pr_open "$repo" fmt-a "lock/plan-fmt: a")" || { drop_work "$work"; return 1; }
  got="$(wait_lock_status "$repo" "$head_a" success)"
  log "A ($pr_a) at ${head_a:0:8}: terragucci/lock ${got:-none}"
  [ "$got" = "success holds canary/one" ] || { log "A does not hold canary/one"; drop_work "$work"; return 1; }
  perl -pi -e 's/^  input = trimspace/  input    =    trimspace/' "$work/tree/canary/one/main.tf"
  head_u="$(push_tree "$work/tree" "$repo" fmt-a "lock/plan-fmt: unformatted")" || { drop_work "$work"; return 1; }
  wait_run "$repo" "$head_u" push || { drop_work "$work"; return 1; }
  for i in $(seq 1 20); do
    head_f="$(remote_head "$repo" fmt-a)"
    [ -n "$head_f" ] && [ "$head_f" != "$head_u" ] && break
    sleep 3
  done
  if [ -z "$head_f" ] || [ "$head_f" = "$head_u" ]; then
    log "the fmt job pushed no formatting onto fmt-a"; drop_work "$work"; return 1
  fi
  log "the fmt job formatted fmt-a: ${head_u:0:8} -> ${head_f:0:8}; runs on the formatted head: $(api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$head_f" | jq '.workflow_runs | length')"
  got="$(TIMEOUT=180 wait_lock_status "$repo" "$head_f" success)"
  log "A at the formatted head: terragucci/lock ${got:-none}; lock: $(lock_file "$repo" | jq -c '.locks["canary/one"] | {pr, head}' 2>/dev/null)"
  # A change to canary/one's main.tf also reaches the fleet roots, so the answer may hold more than canary/one.
  case "$got" in "success holds canary/one"*) ;; *) log "the formatted head of A has no lock answer"; rc=1 ;; esac
  [ "$(lock_file "$repo" | jq -r '.locks["canary/one"].head // empty' 2>/dev/null)" = "$head_f" ] || { log "the lock on canary/one is not at the formatted head"; rc=1; }
  drop_work "$work"
  [ $rc = 0 ] && log "the fmt job's formatting commit got terragucci/lock success and A holds canary/one at it"
  return $rc
}

claim_drift/github() {
  # stack/mock-github, as this tree has it, in a container of the claim's own:
  # it lists a repo's issues as github.com does, pull requests among them, and
  # answers 422 to a query parameter github.com does not take, such as
  # type=issues. One root's queue is applied, then its timeout changed in
  # floci. tf-drift --forge github must open the drift issue on the mock, and
  # a second run must find that issue and update it: one open drift issue.
  # BREAK: was a bundle whose findIssue sent type=issues on GitHub too,
  # which the mock refuses. findIssue is chant's pr-forge's since #899, so
  # the BREAK run fails as unowned (break_unowned) until chant carries it.
  log() { echo "[smoke github-drift-issue] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work queue="tg-ghdrift-$STAMP" key="github-drift-issue/$STAMP.tfstate" tree url image mock="tgs-mockgh-$STAMP" port issues i rc=0 run
  local bundle="$HERE/../packages/terragucci/dist/terragucci.mjs" gh_token=tg-mock-github-token gh_repo=terragucci-admin/drift
  image="$(image_tag tofu)"
  build_cli || return 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  if [ -n "${BREAK:-}" ]; then
    bundle="$work/break.mjs"
    # The issue query is chant's since #899 (pr-forge's findIssue): no cut
    # here sends type=issues to GitHub.
    break_unowned "drift/github's issue query moved to chant's pr-forge (#899)" \
      || { log "the BREAK bundle did not build"; drop_work "$work"; return 1; }
  fi
  docker run -d --name "$mock" --network "${TG_NETWORK:-terragucci}" -p 127.0.0.1::8188 -v "$HERE/mock-github:/srv:ro" \
    -e PORT=8188 -e MOCK_TOKEN="$gh_token" -e MOCK_PUBLIC_URL="http://$mock:8188" \
    public.ecr.aws/docker/library/node:22-bookworm node /srv/server.mjs >/dev/null || { log "the mock did not start"; drop_work "$work"; return 1; }
  port="$(docker port "$mock" 8188/tcp | head -1 | sed 's/.*://')"
  for i in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$port/__mock/health" 2>/dev/null && break; sleep 1; done
  ghm() { curl -fsS -H "Authorization: Bearer $gh_token" -H 'content-type: application/json' "$@"; }
  ghm -o /dev/null -d '{"name":"drift","default_branch":"main"}' "http://127.0.0.1:$port/api/v3/user/repos" || { log "could not make the repo on the mock"; docker rm -f "$mock" >/dev/null 2>&1; drop_work "$work"; return 1; }
  tree="$work/tree"
  respond_tree "$work" "$gh_repo" "$(respond_root "$key" "resource \"aws_sqs_queue\" \"jobs\" {
  name                       = \"$queue\"
  visibility_timeout_seconds = 30
  tags                       = { owner = \"smoke\" }
}")"
  in_image "$tree" sh -c 'cd app && tofu init -input=false -no-color >/dev/null && tofu apply -auto-approve -input=false -no-color >/dev/null' >&2 || { log "the first apply failed"; docker rm -f "$mock" >/dev/null 2>&1; drop_work "$work"; return 1; }
  url="$(sqs GetQueueUrl "{\"QueueName\":\"$queue\"}" | jq -r .QueueUrl)"
  sqs SetQueueAttributes "{\"QueueUrl\":\"$url\",\"Attributes\":{\"VisibilityTimeout\":\"45\"}}" >/dev/null || { log "could not change $queue's timeout"; rc=1; }
  issues() { ghm "http://127.0.0.1:$port/api/v3/repos/$gh_repo/issues?state=open&per_page=100" | jq -c '[.[] | select(.pull_request == null and ((.body // "") | contains("<!-- terragucci:drift -->")))]'; }
  for run in 1 2; do
    run_copied --rm --network "${TG_NETWORK:-terragucci}" -v "$tree:/repo" -w /repo -v "$bundle:/usr/local/bin/terragucci:ro" \
      -v "$JOB_CACHE_VOLUME:/cache" -e TF_PLUGIN_CACHE_DIR=/cache \
      "${AWS_DOCKER_ENV[@]}" \
      -e TF_IN_AUTOMATION=1 -e TF_INPUT=0 \
      -e "GITHUB_REPOSITORY=$gh_repo" -e GITHUB_SERVER_URL=https://github.com -e "GITHUB_API_URL=http://$mock:8188/api/v3" -e "TG_TOKEN=$gh_token" \
      -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
      "$image" terragucci stage tf-drift --forge github >"$work/drift-$run.log" 2>&1 || true
    clean_mounted "$tree" "$image"
    grep -i 'drift issue\|issue' "$work/drift-$run.log" | tail -3 | sed "s/^/[smoke github-drift-issue] run $run: /" >&2 || true
    log "after run $run: $(issues | jq -r 'map("#\(.number)") | join(", ") | if . == "" then "no drift issue" else "drift issue " + . end')"
  done
  if [ "$(issues | jq length)" != 1 ]; then
    log "expected one open drift issue on the mock after two runs, found $(issues | jq length)"; tail -15 "$work/drift-2.log" >&2; rc=1
  elif ! grep -q 'drift issue updated' "$work/drift-2.log"; then
    log "the second run did not update the issue the first opened"; tail -15 "$work/drift-2.log" >&2; rc=1
  fi
  sqs DeleteQueue "{\"QueueUrl\":\"$url\"}" >/dev/null 2>&1 || true
  curl -s -o /dev/null -X DELETE "$FLOCI/shop-terraform-state/$key" || true
  docker rm -f "$mock" >/dev/null 2>&1 || true
  drop_work "$work" "$image" 2>/dev/null || true
  [ $rc = 0 ] && log "the first run opened the drift issue on the mock and the second updated it: one open drift issue"
  return $rc
}

claim_apply/runner_nudge() {
  # Forgejo 16 moves no task version when a run ends with no task reporting
  # (forgejo#14576), so a run queued behind it in a concurrency group waits
  # until something else moves it. This makes that state on purpose: run 1's
  # job asks for a label no runner has, so it waits; run 2, pushed after it in
  # the same group, queues behind it; then run 1 is cancelled, which frees the
  # group and moves nothing. The claim holds the stack alone, so no other job
  # moves the version either. lib.sh's runner_watch, polled by wait_run, sees
  # a job waiting with nothing running and restarts the runner, and run 2
  # succeeds. BREAK: TG_RUNNER_WATCH=off, so run 2 is still waiting after three
  # minutes.
  log() { echo "[smoke runner-nudge] $*" >&2; }
  # shellcheck source=lib.sh
  . "$HERE/lib.sh"
  local work repo="$USER/runner-nudge" tree sha1 sha2 r1="" r2="" i rc=0 t0
  work="$(mktemp -d "${TMPDIR:-/tmp}/terragucci-smoke.XXXXXX")"; track_work "$work"
  fresh_repo runner-nudge || return 1
  tree="$work/tree"
  mkdir -p "$tree/.forgejo/workflows"
  nudge_flow() { printf 'on: push\nconcurrency:\n  group: nudge\n  cancel-in-progress: false\njobs:\n  a:\n    runs-on: %s\n    steps:\n      - run: echo ran\n' "$1" > "$tree/.forgejo/workflows/nudge.yml"; }
  nudge_run() { api "$URL/api/v1/repos/$repo/actions/runs?head_sha=$1" | jq -r '.workflow_runs[0].id // empty'; }
  nudge_flow terragucci-no-runner-has-this
  sha1="$(push_tree "$tree" "$repo" main "run 1: a label no runner serves")" || { drop_work "$work"; return 1; }
  for i in $(seq 1 30); do r1="$(nudge_run "$sha1")"; [ -n "$r1" ] && break; sleep 2; done
  [ -n "$r1" ] || { log "no run for $sha1"; drop_work "$work"; return 1; }
  nudge_flow docker
  sha2="$(push_tree "$tree" "$repo" main "run 2: queued behind run 1")" || { drop_work "$work"; return 1; }
  for i in $(seq 1 30); do r2="$(nudge_run "$sha2")"; [ -n "$r2" ] && break; sleep 2; done
  [ -n "$r2" ] || { log "no run for $sha2"; drop_work "$work"; return 1; }
  # A job still running elsewhere would move the version when it ends.
  for i in $(seq 1 60); do
    [ "$(api "$URL/api/v1/admin/actions/runners/jobs" | jq '[.[]? | select(.status == "running")] | length')" = 0 ] && break
    sleep 2
  done
  log "run 2 ($r2) is $(api "$URL/api/v1/repos/$repo/actions/runs/$r2" | jq -r .status) behind run 1 ($r1); cancelling run 1"
  api -o /dev/null -X POST "$URL/api/v1/repos/$repo/actions/runs/$r1/cancel" || { log "could not cancel run 1"; drop_work "$work"; return 1; }
  [ -n "${BREAK:-}" ] && TG_RUNNER_WATCH=off
  t0="$(date +%s)"
  if TIMEOUT=180 wait_run "$repo" "$sha2" push && [ "$RUN_STATUS" = success ]; then
    log "run 2 succeeded $(( $(date +%s) - t0 ))s after run 1 was cancelled, after $RUNNER_NUDGES runner restart(s)"
  else
    log "run 2 did not succeed within three minutes of run 1's cancel (status ${RUN_STATUS:-waiting})"
    api -o /dev/null -X POST "$URL/api/v1/repos/$repo/actions/runs/$r2/cancel" 2>/dev/null || true
    rc=1
  fi
  TG_RUNNER_WATCH=on
  drop_work "$work"
  return $rc
}

names() { only "$(cut -d'|' -f1 <<<"$CLAIMS")"; }
# The names given, kept to SMOKE_ONLY when it is set.
only() {
  if [ -z "$SMOKE_ONLY" ]; then echo "$1"; return 0; fi
  grep -xF -f <(echo "$SMOKE_ONLY") <<<"$1" || true
}
# The claims with no issue to wait for, in CLAIMS order.
runnable_names() {
  if [ -n "${SMOKE_AWS:-}" ]; then
    # Only the pilot's claims run on real AWS.
    only "$(awk -F'|' '$3 == "" { print $1 }' <<<"$CLAIMS")" | while read -r n; do smoke_aws_claim "$n" && echo "$n"; done
    return 0
  fi
  only "$(awk -F'|' '$3 == "" { print $1 }' <<<"$CLAIMS")"
}

