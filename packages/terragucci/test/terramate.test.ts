// Terramate mode: detection, stacks and their waves from `terramate list` and
// `terramate experimental run-graph` (stubbed), inputs read from the stacks'
// own files, the generate check, and init's pipeline.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import {
  detectTerramate,
  parseInputs,
  parseRunGraph,
  parseStackId,
  stackWaves,
  TERRAMATE_EDGES_FILE,
  TERRAMATE_GENERATE,
  TERRAMATE_VERSION,
  terramateGraph,
  terramateShape,
  terramateWrite,
} from "../src/terramate";
import { atmosDependencies, atmosEdges, fillReads, READS_VARFILE } from "../src/atmos";
import { rootDependencies } from "../src/detect";
import { ROOTS_NOT_TERRAMATE, resolveRepo } from "../src/config";
import { init } from "../src/init";
import { release } from "../src/install";
import { affectedRoots } from "../src/report/stage";
import { git, tmp, write } from "./helpers";

const TF = 'terraform {\n  backend "local" {}\n}\nresource "terraform_data" "x" {\n  input = 1\n}\n';

/** The fixture of the guide: network (tag net), db before app, app after tag:net and reading network's name. */
const FILES: Record<string, string> = {
  "terramate.tm.hcl": 'terramate {\n  config {\n    experiments = ["outputs-sharing"]\n  }\n}\n',
  "stacks/network/stack.tm.hcl": 'stack {\n  name = "network"\n  id   = "network" # the id inputs name\n  tags = ["net"]\n}\n',
  "stacks/network/main.tf": TF,
  "stacks/db/stack.tm.hcl": 'stack {\n  id     = "db"\n  before = ["/stacks/app"]\n}\n',
  "stacks/db/main.tf": TF,
  "stacks/app/stack.tm.hcl":
    'stack {\n  id    = "app"\n  after = ["tag:net"]\n}\n\n// shared from network\ninput "net_name" {\n  backend       = "default"\n  from_stack_id = "network"\n  value         = outputs.name.value\n  mock          = "x"\n}\n',
  "stacks/app/main.tf": TF,
};

const GRAPH = `digraph  {
\tn1[label="/stacks/app"];
\tn2[label="/stacks/db"];
\tn3[label="/stacks/network"];
\tn2->n1;
\tn3->n1[color="red"];
}
`;

/** A `terramate` that lists `stacks`, prints `graph` for run-graph, and exits `generate` for generate --detailed-exit-code. */
function stubTerramate(stacks: string[], graph = GRAPH, generate = 0, warn = ""): string {
  const dir = tmp("terramate-stub-");
  writeFileSync(join(dir, "list.txt"), stacks.map((s) => `${s}\n`).join(""));
  writeFileSync(join(dir, "graph.dot"), graph);
  const bin = join(dir, "terramate");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `case "$1" in`,
      `  list) cat ${JSON.stringify(join(dir, "list.txt"))} ;;`,
      `  experimental) ${warn ? `echo ${JSON.stringify(warn)} >&2; ` : ""}cat ${JSON.stringify(join(dir, "graph.dot"))} ;;`,
      `  generate) [ ${generate} = 2 ] && printf -- '- /stacks/app\\n\\t[~] backend.tf\\n'; exit ${generate} ;;`,
      `  *) echo "unexpected: $*" >&2; exit 9 ;;`,
      "esac",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

const STACKS = ["stacks/app", "stacks/db", "stacks/network"];

describe("detectTerramate", () => {
  it("finds terramate.tm.hcl at the root, else a stack.tm.hcl below it", () => {
    expect(detectTerramate(write(tmp(), { "terramate.tm.hcl": "" }))).toBe("terramate.tm.hcl");
    expect(detectTerramate(write(tmp(), { "a/b/stack.tm.hcl": "stack {}\n" }))).toBe("a/b/stack.tm.hcl");
    expect(detectTerramate(write(tmp(), { "node_modules/x/stack.tm.hcl": "", "main.tf": "" }))).toBeUndefined();
  });
});

describe("reading the stacks", () => {
  it("reads run-graph's edges, the stack id and the inputs, comments left out", () => {
    expect(parseRunGraph(GRAPH)).toEqual([["stacks/db", "stacks/app"], ["stacks/network", "stacks/app"]]);
    expect(parseStackId(FILES["stacks/network/stack.tm.hcl"])).toBe("network");
    expect(parseInputs("stacks/app", FILES["stacks/app/stack.tm.hcl"])).toEqual([
      { var: "net_name", fromStackId: "network", output: ["name"], function: 'input "net_name" from stack network, outputs.name.value' },
    ]);
    expect(parseInputs("s", 'input "a" {\n  from_stack_id = "n"\n  value = outputs.subnets.value.private["az-1"]\n}\n')[0].output).toEqual(["subnets", "private", "az-1"]);
  });

  it("refuses an input whose value terragucci does not evaluate, naming terraform_remote_state", () => {
    expect(() => parseInputs("s", 'input "a" {\n  from_stack_id = "n"\n  value = tolist(outputs.x.value)\n}\n')).toThrow(/does not evaluate.*terraform_remote_state/);
    expect(() => parseInputs("s", 'input "a" {\n  from_stack_id = global.id\n  value = outputs.x.value\n}\n')).toThrow(/without a literal from_stack_id/);
  });

  it("orders by after, before, nesting and inputs, through a stack with no Terraform", () => {
    const repo = write(tmp(), { ...FILES, "stacks/network/sub/stack.tm.hcl": "stack {}\n", "stacks/network/sub/main.tf": TF, "k8s/stack.tm.hcl": "stack {}\n", "k8s/apps/stack.tm.hcl": "stack {}\n", "k8s/apps/main.tf": TF });
    const paths = [...STACKS, "stacks/network/sub", "k8s", "k8s/apps"];
    const stacks = terramateGraph(repo, paths, [...parseRunGraph(GRAPH), ["stacks/db", "k8s"]]);
    const by = Object.fromEntries(stacks.map((s) => [s.path, s]));
    expect(by["stacks/app"].dependencies).toEqual(["stacks/db", "stacks/network"]);
    expect(by["stacks/app"].reads).toEqual([{ var: "net_name", upstream: "stacks/network", output: ["name"], function: 'input "net_name" from stack network, outputs.name.value' }]);
    expect(by["stacks/network/sub"].dependencies).toEqual(["stacks/network"]);
    // k8s holds no Terraform: k8s/apps runs after its parent, and so after db, which runs before k8s.
    expect(by["k8s"].terraform).toBe(false);
    expect(by["k8s/apps"].dependencies).toEqual(["stacks/db"]);
    expect(stackWaves(stacks)).toEqual([["stacks/db", "stacks/network"], ["k8s/apps", "stacks/app", "stacks/network/sub"]]);
  });

  it("counts an input as an edge with no after, and refuses an unknown id and a cycle", () => {
    const repo = write(tmp(), FILES);
    expect(terramateGraph(repo, STACKS, []).find((s) => s.path === "stacks/app")!.dependencies).toEqual(["stacks/network"]);
    expect(() => terramateGraph(write(tmp(), { ...FILES, "stacks/network/stack.tm.hcl": "stack {}\n" }), STACKS, [])).toThrow(/reads net_name from stack network, which no stack has as its id/);
    expect(() => stackWaves(terramateGraph(repo, STACKS, [["stacks/app", "stacks/network"]]))).toThrow(/cycle/i);
  });
});

describe("terramate generate in the jobs", () => {
  it("fails on stale generated code with what Terramate changed", async () => {
    const repo = write(tmp(), FILES);
    await expect(terramateWrite(repo, { terramate: stubTerramate(STACKS, GRAPH, 2) })).rejects.toThrow(/the generated code is stale[\s\S]*backend\.tf[\s\S]*run terramate generate and commit/);
    expect(existsSync(join(repo, "stacks/app", TERRAMATE_EDGES_FILE))).toBe(false);
  });

  it("writes each stack's edges, which affected selection and the inputs read", async () => {
    const repo = write(tmp(), FILES);
    const lines = await terramateWrite(repo, { terramate: stubTerramate(STACKS) });
    expect(lines).toContain("stacks/app: after stacks/db, stacks/network, reads net_name from stacks/network");
    expect(atmosEdges(join(repo, "stacks/app"))?.dependencies).toEqual(["stacks/db", "stacks/network"]);
    expect(atmosDependencies(repo, STACKS).get("stacks/app")).toEqual(new Set(["stacks/db", "stacks/network"]));
    expect(rootDependencies(repo, STACKS).get("stacks/app")).toEqual(new Set(["stacks/network"]));
    // The input waits for network's state, then is filled from its outputs; never from the mock.
    expect((await fillReads(repo, "stacks/app", async () => ({ outputs: {} }))).waiting.map((w) => w.why)).toEqual(["has no state yet"]);
    const filled = await fillReads(repo, "stacks/app", async () => ({ outputs: { name: "net-1" } }));
    expect(filled.filled).toEqual(["net_name"]);
    expect(JSON.parse(readFileSync(join(repo, "stacks/app", READS_VARFILE), "utf-8"))).toEqual({ net_name: "net-1" });
  });

  it("refuses an after or before that names no stack, where Terramate only warns", async () => {
    const repo = write(tmp(), FILES);
    const tm = stubTerramate(STACKS, GRAPH, 0, "Warning: Stack /stacks/app references an invalid path (/nope) in the 'after' attribute");
    await expect(terramateWrite(repo, { terramate: tm })).rejects.toThrow(/references an invalid path \(\/nope\).*fix the path/);
  });

  it("plans a changed stack's dependents by order, as well as by state reads", async () => {
    const repo = write(tmp(), { ...FILES, "terragucci.yml": "forge: forgejo\n" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    git(repo, "checkout", "-q", "-b", "change");
    writeFileSync(join(repo, "stacks/db/main.tf"), `${TF}# moved\n`);
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "db moves");
    await terramateWrite(repo, { terramate: stubTerramate(STACKS) });
    const lines: string[] = [];
    expect(affectedRoots(repo, "main", STACKS, STACKS, (l) => lines.push(l))).toEqual(new Set(["stacks/db", "stacks/app"]));
    expect(lines).toContain("affected: stacks/app depends on stacks/db");
  });
});

describe("init in a Terramate repo", () => {
  const body = (content: string): Record<string, { steps?: { run?: string }[] }> => (parseYAML(content) as { jobs: Record<string, { steps?: { run?: string }[] }> }).jobs;

  it("takes the stacks as roots, one wave per layer of their order, each job installing Terramate and running the generate check", async () => {
    const repo = write(tmp(), { ...FILES, "terragucci.yml": "forge: forgejo\nbinary: tofu\ngate: always\n" });
    const r = await init(repo, { terramate: stubTerramate(STACKS) });
    expect(r.terramate).toEqual({ reason: "terramate.tm.hcl", version: TERRAMATE_VERSION, skipped: [] });
    expect(r.roots).toEqual(["stacks/app", "stacks/db", "stacks/network"]);
    expect(r.layers).toEqual([["stacks/db", "stacks/network"], ["stacks/app"]]);
    const jobs = body(r.files[0].content);
    for (const k of ["check", "apply-wave-1", "apply-wave-2"]) {
      const runs = (jobs[k].steps ?? []).map((s) => s.run ?? "").join("\n");
      expect(runs, k).toContain(`terragucci install terramate ${TERRAMATE_VERSION}`);
      expect(runs, k).toContain(`( set -e; ${TERRAMATE_GENERATE} )`);
    }
  });

  it("refuses roots, synth, a drift pull request, and a repo that is a Terragrunt repo too", async () => {
    const tm = stubTerramate(STACKS);
    await expect(init(write(tmp(), { ...FILES, "terragucci.yml": 'forge: forgejo\nroots: ["stacks/*"]\n' }), { terramate: tm, dryRun: true })).rejects.toThrow(ROOTS_NOT_TERRAMATE);
    await expect(init(write(tmp(), { ...FILES, "terragucci.yml": "forge: forgejo\nsynth: make\n" }), { terramate: tm, dryRun: true })).rejects.toThrow(/remove synth/);
    await expect(init(write(tmp(), { ...FILES, "terragucci.yml": 'forge: forgejo\ndrift: "0 6 * * *"\n' }), { terramate: tm, dryRun: true })).rejects.toThrow(/respond.drift: .*terramate generate owns/);
    await expect(init(write(tmp(), { ...FILES, "root.hcl": "", "terragucci.yml": "forge: forgejo\n" }), { terramate: tm, dryRun: true })).rejects.toThrow(/one at a time/);
  });

  it("is one shape: per-root, prepared by the generate check, edits in the stack", () => {
    const shape = terramateShape(write(tmp(), FILES))!;
    expect([shape.kind, shape.engine, shape.prepare, shape.sourceOf("stacks/app")]).toEqual(["terramate", "per-root", TERRAMATE_GENERATE, "stacks/app"]);
    expect(shape.refuses("roots", resolveRepo({}))).toBeUndefined();
    expect(terramateShape(write(tmp(), { "main.tf": "" }))).toBeUndefined();
  });
});

describe("install terramate", () => {
  it("fetches the release's Linux tar.gz, named x86_64 for amd64, checked against checksums.txt", () => {
    expect(release("terramate", "0.17.3", "amd64")).toEqual({
      url: "https://github.com/terramate-io/terramate/releases/download/v0.17.3/terramate_0.17.3_linux_x86_64.tar.gz",
      sums: "https://github.com/terramate-io/terramate/releases/download/v0.17.3/checksums.txt",
      file: "terramate_0.17.3_linux_x86_64.tar.gz",
      kind: "tar.gz",
    });
  });
});
