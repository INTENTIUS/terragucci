#!/bin/sh
# Destroy one terralith cycle's resources (stack/demo.sh, tl_destroy_bg). It
# runs in the demo's job image, in a container the driver starts and does not
# wait on, with the cycle's stock tree copied to /w. The stock root's state,
# which the adoption leaves in the bucket as it was, lists every resource the
# cycle made, so a stock destroy removes them whatever estate their tags now
# name. Then it deletes that state, its lock file and the cycle's records.
#
#   TL_STATE    <state bucket>/<the cycle's state key>
#   TL_RECORDS  <record store bucket>/<the prefix of the cycle's records>
set -eu
cd /w/terralith
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
