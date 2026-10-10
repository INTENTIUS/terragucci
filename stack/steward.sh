#!/usr/bin/env bash
#
# The example's apply on a fountain steward. Needs the forgejo and fountain
# profiles up (stack/bootstrap.sh forgejo, stack/bootstrap.sh fountain);
# stack/example.sh up --fountain runs all of it.
#
#   stack/steward.sh declare <owner/repo>   declare the steward for the repo on
#                                           fountain, and give the repo the
#                                           FOUNTAIN_TOKEN its apply job uses
#   stack/steward.sh overlay <dir>          make the tree in <dir> hand tf-apply
#                                           to the steward: chant.config.ts, a
#                                           tf-apply Op with one step per wave,
#                                           and the pipeline's wave jobs replaced
#                                           by one job that runs
#                                           `chant run tf-apply --on fountain`
#                                           and fails unless a new turn
#                                           completed
#   stack/steward.sh turns                  the steward's turns on its current
#                                           conversation, one per line: number,
#                                           status, prompt, turn id
#
# The steward is one fountain Agent on the acp runtime, whose command is
# `chant acp`, seated as a Teammate so its turns land on one thread. Its
# sandbox is a directory on the stack's fountain runner, and the sandbox is a
# checkout of the repo: chant reads a project from the session's working
# directory, which fountain sets to the sandbox itself.
#
# TG_STEWARD_HANDOVER=0 makes overlay leave the pipeline's wave jobs as they
# are, so the forge applies and the steward runs nothing (the steward smoke
# claim's BREAK).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMD="${1:-}"; shift || true

log()  { echo "[steward] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

NAME="terragucci-steward"
# The global node_modules of the steward image, where chant and its fountain
# lexicon are installed (stack/fountain/Dockerfile).
MODULES="/usr/local/lib/node_modules"

fountain_env() {
  if [ -z "${TERRAGUCCI_FOUNTAIN_TOKEN:-}" ]; then
    [ -f "${TG_STATE:-$HERE/.state}/fountain.env" ] || fail "no stack/.state/fountain.env; run 'stack/bootstrap.sh fountain' first"
    # shellcheck disable=SC1091
    . "${TG_STATE:-$HERE/.state}/fountain.env"
  fi
  FOUNTAIN="$TERRAGUCCI_FOUNTAIN_URL"
  FKEY="$TERRAGUCCI_FOUNTAIN_TOKEN"
  STEWARD_IMAGE="${TERRAGUCCI_FOUNTAIN_STEWARD_IMAGE:-terragucci-fountain-steward:local}"
}
fapi() { curl -fsS -H "Authorization: Bearer $FKEY" -H 'content-type: application/json' "$@"; }

# The steward's teammate entry from the team roster, or nothing.
teammate() {
  fapi "$FOUNTAIN/api/team" | jq -c --arg n "$NAME" '[.data[] | select(.name == $n or .agent.name == $n)][0] // empty'
}

case "$CMD" in
  declare)
    repo="${1:?usage: steward.sh declare <owner/repo>}"
    fountain_env
    # shellcheck source=lib.sh
    . "$HERE/lib.sh"

    # The steward's own Forgejo token, kept in the stack's state while it
    # authenticates, so the environment it is written into stays the same
    # from one boot to the next. It pushes the gate's pending facts and the
    # run ledger to chant/lifecycle; the clone itself is anonymous.
    STEWARD_STATE="${TG_STATE:-$HERE/.state}/steward.env"
    stoken=""
    [ -f "$STEWARD_STATE" ] && stoken="$(sed -n 's/^STEWARD_FORGEJO_TOKEN=//p' "$STEWARD_STATE")"
    if [ -z "$stoken" ] || ! curl -fs -o /dev/null -H "Authorization: token $stoken" "$URL/api/v1/user"; then
      pw="Terragucci-local-pw-1234"
      curl -s -o /dev/null -u "$USER:$pw" -X DELETE "$URL/api/v1/users/$USER/tokens/$NAME" || true
      stoken="$(curl -fsS -u "$USER:$pw" -H 'content-type: application/json' \
        -d "{\"name\":\"$NAME\",\"scopes\":[\"write:repository\"]}" "$URL/api/v1/users/$USER/tokens" | jq -r '.sha1 // empty')"
      [ -n "$stoken" ] || fail "could not mint the steward's Forgejo token"
      mkdir -p "$(dirname "$STEWARD_STATE")"
      echo "STEWARD_FORGEJO_TOKEN=$stoken" > "$STEWARD_STATE"
    fi

    # Inside the stack the forge is http://forgejo:3000, whatever the host calls it.
    fetch_url="http://forgejo:3000/$repo.git"
    push_url="http://$USER:$stoken@forgejo:3000/$repo.git"

    # Runs once, when fountain provisions the sandbox, in the sandbox
    # directory: make it a checkout of the repo that resolves chant from the
    # image. main may not be pushed yet; every turn fetches it again.
    setup='set -e
cd "$HOME"
[ -d .git ] || git init -q -b main .
git remote get-url origin >/dev/null 2>&1 || git remote add origin "$TG_STEWARD_FETCH"
git remote set-url origin "$TG_STEWARD_FETCH"
git remote set-url --push origin "$TG_STEWARD_PUSH"
git config user.name terragucci-steward
git config user.email steward@terragucci.local
ln -sfn '"$MODULES"' node_modules
grep -qx node_modules .git/info/exclude 2>/dev/null || echo node_modules >> .git/info/exclude
if git fetch -q origin main 2>/dev/null; then git checkout -q -f -B main FETCH_HEAD; else echo "main is not pushed yet; the first turn fetches it"; fi'
    # Each turn starts on main as it is now. Nothing may reach stdout before
    # chant acp does, since stdout is the protocol, and exec keeps an
    # interrupt from leaving chant running behind the shell.
    command='git fetch -q origin main >&2 && git checkout -q -f -B main FETCH_HEAD >&2; exec chant acp'

    manifest="$(jq -n --arg name "$NAME" --arg setup "$setup" --arg cmd "$command" \
      --arg fetch "$fetch_url" --arg push "$push_url" --arg repo "$repo" '{resources: [
      {kind: "Environment", name: $name, spec: {
        networking_type: "unrestricted",
        setup_script: $setup,
        setup_timeout_seconds: 300,
        env_vars: {
          TG_STEWARD_FETCH: $fetch, TG_STEWARD_PUSH: $push,
          AWS_ENDPOINT_URL: "http://floci:4566", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test"
        },
        metadata: {"managed-by": "terragucci"}
      }},
      {kind: "Agent", name: $name, spec: {
        description: ("One writer for " + $repo + ": runs its tf-apply"),
        runtime: "acp",
        runtime_command: $cmd,
        sandbox_mode: "persistent",
        sandbox_provider: "runner",
        environment: $name,
        permission_policy: {default: "auto_allow"},
        allowed_vault_ids: [],
        metadata: {"managed-by": "terragucci"}
      }},
      {kind: "Teammate", name: $name, spec: {agent: $name, environment: $name}}
    ]}')"
    out="$(fapi -X POST -d "$manifest" "$FOUNTAIN/api/apply")" || fail "fountain refused the steward's manifest"
    if jq -e '[.. | objects | select(.action? == "error")] | length > 0' <<<"$out" >/dev/null; then
      jq -c '.. | objects | select(.action? == "error")' <<<"$out" >&2
      fail "fountain could not apply the steward"
    fi
    log "declared $NAME on fountain: $(jq -r '[.. | objects | select(.action? and .kind?) | "\(.kind) \(.action)"] | join(", ")' <<<"$out")"

    # The apply job calls fountain with this key. In a real setup it would be
    # a key that can post to the steward and nothing more.
    api -o /dev/null -H 'content-type: application/json' -X PUT -d "$(jq -n --arg k "$FKEY" '{data: $k}')" \
      "$URL/api/v1/repos/$repo/actions/secrets/FOUNTAIN_TOKEN" || fail "could not set FOUNTAIN_TOKEN on $repo"

    # A teammate's computer provisions when it is seated; wait for it, so the
    # first apply does not post to a sandbox that is still being made.
    for i in $(seq 1 150); do
      state="$(teammate | jq -r '.presence.state // empty')"
      case "$state" in
        online|asleep|working) log "$NAME is $state"; break ;;
        failed) fail "the steward's sandbox failed to provision: $(teammate | jq -r '.presence.label // empty')" ;;
      esac
      sleep 2
      [ "$i" = 150 ] && fail "the steward is still '${state:-absent}' after 5 minutes"
    done
    ;;

  overlay)
    dir="${1:?usage: steward.sh overlay <dir>}"
    fountain_env
    wf="$dir/.forgejo/workflows/terragucci.yml"
    [ -f "$wf" ] || fail "no $wf"
    cat > "$dir/chant.config.ts" <<'TS'
// The steward this repo's apply runs on. `chant run tf-apply --on fountain`
// posts to the teammate named here; the token is the forge secret
// FOUNTAIN_TOKEN, never a literal.
export default {
  lexicons: ["fountain"],
  fountain: {
    profiles: {
      local: {
        endpoint: "http://fountain:4000",
        token: { env: "FOUNTAIN_TOKEN" },
        team: "terragucci-steward",
      },
    },
    defaultProfile: "local",
  },
};
TS
    python3 - "$wf" "$dir/tf-apply.op.ts" "$STEWARD_IMAGE" "${TG_STEWARD_HANDOVER:-1}" "$MODULES" "$NAME" <<'PY'
import json, re, sys
wf, op, image, handover, modules, name = sys.argv[1:]
s = open(wf).read()
head, jobs = s.split("\njobs:\n", 1)
# One block per job: "  name:\n" and the indented lines under it.
blocks = re.split(r"(?m)^(?=  [a-z0-9-]+:$)", jobs)
waves, kept, cond = [], [], None
for b in blocks:
    m = re.match(r"  (apply-wave-(\d+)):\n", b)
    if not m:
        kept.append(b)
        continue
    line = re.search(r"terragucci stage tf-apply (.+?)(?: 2>&1 \| tee \"\$log\")?$", b, re.M)
    assert line, m.group(1)
    waves.append((int(m.group(2)), line.group(1)))
    if cond is None:
        cond = re.search(r"(?m)^    if: (.*)$", b).group(1)
        kept.append("@@APPLY@@")
assert waves, "the pipeline has no apply-wave jobs"
waves.sort()

steps = [
    '    // Every turn starts on main as it is now.\n'
    '    phase("Checkout", [shell("git fetch -q origin main && git checkout -q -f -B main FETCH_HEAD", { id: "checkout" })]),'
]
for n, args in waves:
    cmd = "terragucci stage tf-apply " + args
    steps.append(
        f'    phase("Wave {n}", [\n'
        f'      shell({json.dumps(cmd)}, {{\n'
        f'        id: "wave-{n}",\n'
        f'        timeout: "45m",\n'
        f'        // 3 is a wave waiting for its approval: the run ends gated at that wave.\n'
        f'        gatedExit: 3,\n'
        f'        gate: {{ op: "tf-apply", gate: "wave-{n}" }},\n'
        f'      }}),\n'
        f'    ]),'
    )
open(op, "w").write(
    "// tf-apply on the fountain steward: the waves the forge pipeline would run,\n"
    "// one step each, written by stack/steward.sh from that pipeline. A wave that\n"
    "// has to wait records its pending fact on chant/lifecycle and ends the run\n"
    "// gated; `chant approve tf-apply wave-<n> --sign` and a second run go on.\n"
    'import { Op, phase, shell } from "@intentius/chant/op";\n\n'
    "export const tfApply = Op({\n"
    '  name: "tf-apply",\n'
    f'  overview: "Apply every root, {len(waves)} waves, on the steward",\n'
    "  phases: [\n" + "\n".join(steps) + "\n  ],\n});\n"
)

if handover == "0":
    sys.exit(0)
last = f"apply-wave-{waves[-1][0]}"
job = f"""  apply:
    runs-on: docker
    container:
      image: {image}
    needs: check
    if: {cond}
    concurrency:
      group: terragucci-apply-${{{{ github.repository }}}}
      cancel-in-progress: false
    env:
      FOUNTAIN_TOKEN: '${{{{ secrets.FOUNTAIN_TOKEN }}}}'
    steps:
      - uses: https://code.forgejo.org/actions/checkout@v4
      - name: Apply on the fountain steward
        shell: bash
        run: |
          set -euo pipefail
          # The Op file imports chant, which the image installs globally.
          ln -sfn {modules} node_modules
          node --input-type=module <<'JS'
"""
# The step around `chant run tf-apply --on fountain`. The job trusts a 0 from
# chant only once a new tf-apply turn on the teammate's thread has completed.
STEP = r"""
import { spawnSync } from "node:child_process";
const api = "http://fountain:4000/api";
const name = "@@NAME@@";
const headers = { authorization: `Bearer ${process.env.FOUNTAIN_TOKEN}`, "content-type": "application/json" };
const say = (m) => console.error(`[steward] ${m}`);
const fail = (m) => { say(`FAIL: ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One connection per call: fountain closes idle keep-alive sockets, and a
// reused one fails the next request with EPIPE. A network error is retried.
const call = async (method, path) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(api + path, { method, headers: { ...headers, connection: "close" } });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } catch (err) {
      if (attempt >= 5) throw err;
      say(`${method} ${path}: ${err.cause?.code ?? err.message}, retrying`);
      await sleep(2000 * attempt);
    }
  }
};
const teammate = async () => {
  const { status, body } = await call("GET", "/team");
  if (status !== 200) fail(`GET /api/team answered ${status}`);
  const t = (body.data ?? []).find((t) => t.name === name || t.agent?.name === name);
  if (!t) fail(`no teammate ${name} on fountain`);
  return t;
};
const applyTurns = async () => {
  const conv = (await teammate()).conversation?.id;
  if (!conv) return [];
  const { status, body } = await call("GET", `/conversations/${conv}/turns?limit=500`);
  if (status !== 200) fail(`GET the turns of conversation ${conv} answered ${status}`);
  return (body.data ?? []).filter((t) => (t.prompt ?? "").startsWith("chant run tf-apply"));
};
const until = async (what, secs, fn) => {
  for (let i = 0; i < secs / 3; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(3000);
  }
  fail(`${what} after ${secs}s`);
};

await until("the steward's computer is not up", 300, async () =>
  ["online", "asleep", "working"].includes((await teammate()).presence?.state));

const before = new Set((await applyTurns()).map((t) => t.id));
const run = spawnSync("chant", ["run", "tf-apply", "--on", "fountain"], { stdio: "inherit" });
if (run.error) fail(`could not start chant: ${run.error.message}`);
if (run.status !== 0) process.exit(run.status ?? 1);

const turn = await until("chant reported the run finished, but the steward has no new tf-apply turn", 120, async () =>
  (await applyTurns()).filter((t) => !before.has(t.id)).sort((a, b) => b.turn_number - a.turn_number)[0]);
const now = turn;
if (now.status !== "completed" || now.limit_reason || now.waiting) {
  fail(`the steward's turn ${now.turn_number} ended ${now.status}${now.limit_reason ? ` (${now.limit_reason})` : ""}${now.waiting ? ", waiting on a request" : ""}`);
}
say(`the steward's turn ${now.turn_number} completed`);
""".replace("@@NAME@@", name)
job += "".join(("          " + l if l else "") + "\n" for l in STEP.strip("\n").split("\n")) + "          JS\n"
out = "".join(job if b == "@@APPLY@@" else b for b in kept)
out = re.sub(rf"(?m)^    needs: {last}$", "    needs: apply", out)
open(wf, "w").write(head + "\njobs:\n" + out)
PY
    if [ "${TG_STEWARD_HANDOVER:-1}" = 0 ]; then
      log "wrote chant.config.ts and tf-apply.op.ts; the pipeline's wave jobs are left in place"
    else
      log "wrote chant.config.ts and tf-apply.op.ts; the pipeline hands tf-apply to $NAME"
    fi
    ;;

  turns)
    fountain_env
    conv="$(teammate | jq -r '.conversation.id // empty')"
    [ -n "$conv" ] || fail "no teammate $NAME on fountain; run 'stack/steward.sh declare <owner/repo>' first"
    fapi "$FOUNTAIN/api/conversations/$conv/turns" \
      | jq -r '.data | sort_by(.turn_number)[] | "\(.turn_number)\t\(.status)\t\(.prompt | split("\n")[0])\t\(.id)"'
    ;;

  *)
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
