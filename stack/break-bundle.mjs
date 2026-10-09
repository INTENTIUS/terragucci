// The CLI bundle built from this tree with cuts made in its sources, for a
// smoke claim whose BREAK takes a property out of the code itself:
//
//   node stack/break-bundle.mjs <out.mjs> <file> <find> <replace> [<file> <find> <replace>]...
//
// <file> is a path under packages/terragucci/src. Each <find> must appear
// exactly once in its file, so a source change that moves the code fails the
// build instead of building a bundle that breaks nothing. The rest of the
// bundle is built with the shipped options (scripts/cli-bundle.mjs).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleOptions } from "../scripts/cli-bundle.mjs";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "../packages/terragucci");
const [out, ...rest] = process.argv.slice(2);
if (!out || rest.length === 0 || rest.length % 3 !== 0) {
  console.error("usage: break-bundle.mjs <out.mjs> <file> <find> <replace> [<file> <find> <replace>]...");
  process.exit(2);
}
const cuts = new Map();
for (let i = 0; i < rest.length; i += 3) {
  const file = resolve(pkg, "src", rest[i]);
  cuts.set(file, [...(cuts.get(file) ?? []), { find: rest[i + 1], replace: rest[i + 2] }]);
}
for (const [file, list] of cuts) {
  const text = readFileSync(file, "utf8");
  for (const { find } of list) {
    const n = text.split(find).length - 1;
    if (n !== 1) {
      console.error(`break-bundle: ${file} holds ${JSON.stringify(find)} ${n} times, not once`);
      process.exit(1);
    }
  }
}
const cut = {
  name: "break-cut",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      const list = cuts.get(args.path);
      if (!list) return undefined;
      let text = readFileSync(args.path, "utf8");
      for (const { find, replace } of list) text = text.replace(find, () => replace);
      return { contents: text, loader: "ts" };
    });
  },
};
await build({ ...bundleOptions(pkg, [cut]), outfile: out });
console.error(`break-bundle: ${out}, ${cuts.size} file(s) cut`);
