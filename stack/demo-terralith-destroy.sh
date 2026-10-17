#!/bin/sh
# Destroy one cycle's resources of scenario terralith (stack/demo.sh,
# tl_destroy_bg). It runs in the demo's job image, in a container the driver
# starts and does not wait on, with the cycle's stock tree copied to /w. The
# stock root's backend block names that cycle's state key, so a cycle applied
# before the rename is destroyed from its own terralith/. The stock root's state,
# which the adoption leaves in the bucket as it was, lists every resource the
# cycle made, so a stock destroy removes them whatever estate their tags now
# name. Then it deletes that state, its lock file and the cycle's records.
#
#   TL_ROOT     the stock root's directory: shared, or terralith for a cycle
#               applied before the rename. Unset, the first of the two the
#               tree has.
#   TL_STATE    <state bucket>/<the cycle's state key>
#   TL_RECORDS  <record store bucket>/<the prefix of the cycle's records>
set -eu
root="${TL_ROOT:-}"
if [ -z "$root" ]; then
  for d in shared terralith; do
    if [ -d "/w/$d" ]; then root="$d"; break; fi
  done
fi
[ -n "$root" ] && [ -d "/w/$root" ] || { echo "no stock root under /w" >&2; exit 1; }
cd "/w/$root"
choudoufu init -input=false -no-color >/dev/null
choudoufu destroy -auto-approve -input=false -no-color | tail -1
node --input-type=module -e '
const floci = "http://floci:4566";
const [state, records] = [process.env.TL_STATE, process.env.TL_RECORDS];
for (const key of [state, `${state}.tflock`]) await fetch(`${floci}/${key}`, { method: "DELETE" });
const slash = records.indexOf("/");
const bucket = records.slice(0, slash);
const prefix = records.slice(slash + 1);
const list = await (await fetch(`${floci}/${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`)).text();
let n = 0;
for (const m of list.matchAll(/<Key>([^<]*)<\/Key>/g)) {
  await fetch(`${floci}/${bucket}/${m[1].split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
  n++;
}
console.log(`deleted ${state} and ${n} records under ${records}`);
'
