#!/usr/bin/env bash
# Build terragucci against a local build of chant instead of the pinned release.
#
#   scripts/chant-local.sh [<chant-dir>]   pack chant from <chant-dir> and install it
#   scripts/chant-local.sh --reset         go back to the versions package-lock.json pins
#
# Without <chant-dir>, it uses a worktree of the chant checkout detached at
# chant's origin/main, created on the first run and moved to the latest
# origin/main on every run. The chant checkout itself is never touched.
#
# The packages are every @intentius/chant* that terragucci's package.json files
# name, plus chant-lexicon-fountain (the steward image installs it), plus every
# chant workspace package they depend on. Each is packed with `npm pack`, whose
# prepack generates, bundles and builds it, in an order where a package follows
# the packages it builds against. The tarballs go to .chant-local/ and are
# installed with `npm install --no-save`, so package.json and package-lock.json
# do not change. Each installed package.json gets a "chantLocal" field naming
# the chant commit, which is how `stack/bootstrap.sh` and a reader tell the
# local build from the pin.
#
# Then it rebuilds the bundle (`just build-cli`) and the CI images (`just
# images`). --reset runs `npm ci` and rebuilds both the same way.
#
# Environment:
#   CHANT_REPO              the chant checkout (default: the chant directory
#                           next to terragucci's main checkout)
#   CHANT_LOCAL_WORKTREE    the default worktree (default: chant-local next to
#                           the chant checkout)
#   CHANT_LOCAL_IMAGES=0    skip `just images` (for a machine without Docker)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.chant-local"

log() { printf 'chant-local: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

rebuild() {
  log "rebuilding the bundle"
  (cd "$ROOT" && just build-cli)
  if [ "${CHANT_LOCAL_IMAGES:-1}" = 0 ]; then
    log "CHANT_LOCAL_IMAGES=0: not rebuilding the images; run 'just images' before the stack"
  else
    log "rebuilding the CI images"
    (cd "$ROOT" && just images)
  fi
}

if [ "${1:-}" = --reset ]; then
  [ $# = 1 ] || die "--reset takes no other argument"
  log "reinstalling the pinned versions with npm ci"
  (cd "$ROOT" && npm ci --no-audit --no-fund)
  # `npm ls` exits non-zero on the pin as well (the lock's k8s lexicon wants a
  # newer core as a peer), so compare every installed copy with the lock.
  (cd "$ROOT" && node --input-type=module <<'JS'
import fs from "node:fs";
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")).packages;
const bad = [];
for (const [at, entry] of Object.entries(lock)) {
  if (!/(^|\/)node_modules\/@intentius\/chant[^/]*$/.test(at) || entry.link) continue;
  const f = `${at}/package.json`;
  if (!fs.existsSync(f)) { bad.push(`${at} is missing`); continue; }
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  if (p.version !== entry.version || p.chantLocal) bad.push(`${at} is ${p.version}${p.chantLocal ? " (local build)" : ""}, the lock says ${entry.version}`);
}
if (bad.length) { console.error("chant-local: " + bad.join("\nchant-local: ")); process.exit(1); }
JS
  ) || die "node_modules does not match package-lock.json after npm ci"
  (cd "$ROOT" && npm ls @intentius/chant --depth=0 2>/dev/null || true)
  rebuild
  log "back on the pin: chant $(jq -r .version "$ROOT/node_modules/@intentius/chant/package.json")"
  exit 0
fi
case "${1:-}" in -*) die "unknown flag '$1' (usage: chant-local [<chant-dir>] | --reset)" ;; esac
[ $# -le 1 ] || die "usage: chant-local [<chant-dir>] | --reset"

if [ $# = 1 ]; then
  CHANT="$(cd "$1" && pwd)" || die "no such directory: $1"
  [ -f "$CHANT/packages/core/package.json" ] || die "$CHANT is not a chant checkout"
else
  # The checkout next to terragucci's main checkout, also when this runs in a
  # terragucci worktree somewhere else.
  common="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)/.." && pwd)"
  REPO="${CHANT_REPO:-$(dirname "$common")/chant}"
  [ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || die "no chant checkout at $REPO (set CHANT_REPO or pass a chant directory)"
  CHANT="${CHANT_LOCAL_WORKTREE:-$(dirname "$REPO")/chant-local}"
  log "fetching chant's origin/main"
  git -C "$REPO" fetch -q origin main
  if [ -e "$CHANT" ]; then
    [ -z "$(git -C "$CHANT" status --porcelain --untracked-files=no)" ] \
      || die "the worktree $CHANT has local changes; commit or undo them, or pass a chant directory"
    git -C "$CHANT" checkout -q --detach origin/main
  else
    log "adding the worktree $CHANT"
    git -C "$REPO" worktree add -q --detach "$CHANT" origin/main
  fi
fi

COMMIT="$(git -C "$CHANT" rev-parse HEAD)"
DIRTY=""
[ -z "$(git -C "$CHANT" status --porcelain --untracked-files=no)" ] || DIRTY="+dirty"
MARK="${COMMIT}${DIRTY}"
log "chant at $MARK ($CHANT)"

# npm ci only when the lock changed since the last one in this checkout.
lock_sum="$(shasum -a 256 "$CHANT/package-lock.json" | cut -d' ' -f1)"
stamp="$CHANT/node_modules/.terragucci-chant-local"
if [ "$(cat "$stamp" 2>/dev/null || true)" != "$lock_sum" ]; then
  log "npm ci in chant"
  (cd "$CHANT" && npm ci --no-audit --no-fund)
  printf '%s\n' "$lock_sum" > "$stamp"
fi

# The chant packages terragucci names, the fountain lexicon, and their chant
# dependencies, in build order.
order="$(cd "$ROOT" && node --input-type=module - "$CHANT" <<'JS'
import fs from "node:fs";
import path from "node:path";
const chant = process.argv[2];
const want = new Set(["@intentius/chant-lexicon-fountain"]);
const manifests = ["package.json", ...fs.readdirSync("packages").map((d) => `packages/${d}/package.json`)];
for (const f of manifests) {
  if (!fs.existsSync(f)) continue;
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const n of Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies })) {
    if (n.startsWith("@intentius/chant")) want.add(n);
  }
}
const pkgs = new Map(); // name -> { dir, deps }
for (const top of ["packages", "lexicons"]) {
  for (const d of fs.readdirSync(path.join(chant, top))) {
    const f = path.join(chant, top, d, "package.json");
    if (!fs.existsSync(f)) continue;
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    if (p.private) continue;
    const deps = Object.keys({ ...p.dependencies, ...p.peerDependencies, ...p.optionalDependencies });
    pkgs.set(p.name, { dir: `${top}/${d}`, deps });
  }
}
const need = new Set();
const visit = (n) => {
  if (need.has(n)) return;
  const p = pkgs.get(n);
  if (!p) { console.error(`chant-local: chant has no package ${n}`); process.exit(1); }
  need.add(n);
  for (const d of p.deps) if (pkgs.has(d)) visit(d);
};
for (const n of want) visit(n);
const out = [];
const left = new Set(need);
while (left.size) {
  const ready = [...left].filter((n) => !pkgs.get(n).deps.some((d) => left.has(d) && d !== n)).sort();
  if (!ready.length) { console.error(`chant-local: dependency cycle among ${[...left].join(", ")}`); process.exit(1); }
  for (const n of ready) { out.push(pkgs.get(n).dir); left.delete(n); }
}
console.log(out.join("\n"));
JS
)" || die "cannot work out which chant packages to pack"
DIRS=()
while IFS= read -r d; do [ -n "$d" ] && DIRS+=("$d"); done <<<"$order"
[ "${#DIRS[@]}" -gt 0 ] || die "found no chant packages to pack"

mkdir -p "$OUT"
TARBALLS=()
for d in "${DIRS[@]}"; do
  log "packing $d"
  file="$(cd "$CHANT/$d" && npm pack --silent --pack-destination "$OUT" | tail -n 1)"
  [ -f "$OUT/$file" ] || die "npm pack in $d wrote no tarball"
  # A fixed name per package, so a later run replaces it and the steward
  # image finds it without knowing the version.
  name="$(node -p 'require(process.argv[1]).name' "$CHANT/$d/package.json")"
  fixed="$(printf '%s' "$name" | sed 's#^@##; s#/#-#').tgz"
  [ "$file" = "$fixed" ] || mv -f "$OUT/$file" "$OUT/$fixed"
  TARBALLS+=("$OUT/$fixed")
done
printf '%s\n' "$MARK" > "$OUT/commit"

# The workspace package pins chant too, so installing the tarballs at the root
# alone leaves the pinned copies nested under packages/*/node_modules, and the
# bundle would build from those. Instead, point every package.json at the
# tarballs for the install and put the files back afterwards: npm installs the
# local build everywhere and, with --no-save, writes no lock. --legacy-peer-deps
# because the pinned lexicons still in the tree want the pinned core as a peer
# until npm replaces them.
MANIFESTS=(package.json)
for f in "$ROOT"/packages/*/package.json; do MANIFESTS+=("${f#"$ROOT"/}"); done
mkdir -p "$OUT/manifests"
restore() {
  for f in "${MANIFESTS[@]}"; do
    b="$OUT/manifests/$(printf '%s' "$f" | tr / _)"
    [ -f "$b" ] && cp -p "$b" "$ROOT/$f"
  done
}
for f in "${MANIFESTS[@]}"; do cp -p "$ROOT/$f" "$OUT/manifests/$(printf '%s' "$f" | tr / _)"; done
trap restore EXIT
(cd "$ROOT" && node --input-type=module - "$OUT" "${MANIFESTS[@]}" <<'JS'
import fs from "node:fs";
import path from "node:path";
const [out, ...manifests] = process.argv.slice(2);
const local = new Map();
for (const t of fs.readdirSync(out).filter((f) => f.endsWith(".tgz"))) {
  local.set("@" + t.replace(/\.tgz$/, "").replace("-", "/"), "file:" + path.join(out, t));
}
for (const f of manifests) {
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const n of Object.keys(p[k] ?? {})) if (local.has(n)) p[k][n] = local.get(n);
  }
  // The root also names the packages only reached through a lexicon (k8s,
  // the k8s client) and the fountain lexicon, so npm replaces those copies
  // too instead of keeping a registry release of the same version.
  if (f === "package.json") p.devDependencies = { ...p.devDependencies, ...Object.fromEntries(local) };
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
}
JS
)
log "installing ${#TARBALLS[@]} tarballs with npm install --no-save"
(cd "$ROOT" && npm install --no-save --no-audit --no-fund --legacy-peer-deps)
restore
trap - EXIT

# Every installed copy must be the local build; mark each with the commit, so
# node_modules says what it holds.
(cd "$ROOT" && node --input-type=module - "$MARK" "$CHANT" "$OUT" <<'JS'
import fs from "node:fs";
import path from "node:path";
const [mark, dir, out] = process.argv.slice(2);
const want = new Set(
  fs.readdirSync(out).filter((f) => f.endsWith(".tgz")).map((t) => "@" + t.replace(/\.tgz$/, "").replace("-", "/")),
);
const versions = new Map();
for (const top of ["packages", "lexicons"]) {
  for (const d of fs.readdirSync(path.join(dir, top))) {
    const f = path.join(dir, top, d, "package.json");
    if (fs.existsSync(f)) { const p = JSON.parse(fs.readFileSync(f, "utf8")); versions.set(p.name, p.version); }
  }
}
const bad = [];
let n = 0;
const walk = (nm) => {
  const scope = path.join(nm, "@intentius");
  if (!fs.existsSync(scope)) return;
  for (const d of fs.readdirSync(scope)) {
    const name = `@intentius/${d}`;
    const at = path.join(scope, d);
    const f = path.join(at, "package.json");
    if (!fs.existsSync(f) || fs.lstatSync(at).isSymbolicLink()) continue;
    walk(path.join(at, "node_modules"));
    if (!want.has(name)) continue;
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    if (p.version !== versions.get(name)) { bad.push(`${at} is ${p.version}`); continue; }
    p.chantLocal = { commit: mark, dir };
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
    n++;
  }
};
walk("node_modules");
for (const w of fs.existsSync("packages") ? fs.readdirSync("packages") : []) walk(path.join("packages", w, "node_modules"));
if (bad.length) {
  console.error("chant-local: these copies are not the local build:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.error(`chant-local: marked ${n} installed chant packages with ${mark}`);
JS
)

rebuild

version="$(jq -r .version "$ROOT/node_modules/@intentius/chant/package.json")"
log "terragucci now builds with chant $version from $CHANT"
echo "chant commit: $MARK"
