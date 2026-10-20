/**
 * `modules.test`: the binary's `test` runs on a module before a release of it
 * publishes. A module with no test files is untested, and is refused as one
 * whose tests fail is: the setting says every release is tested.
 *
 * The test files are the binary's own: `*.tftest.hcl` and `*.tftest.json` in
 * the module or its `tests` directory, and OpenTofu's `*.tofutest.hcl` too.
 * The module is initialised without a backend first, which `test` needs for
 * its providers and the modules it calls. The tests run without the forge
 * token, the signing key or the registry login the publish job holds.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { binaryEnv } from "../binary-env";

export type TestBinary = "tofu" | "terraform";

/** The test files the binary reads in a module, relative to it. */
export function testFiles(dir: string, binary: TestBinary): string[] {
  const pattern = binary === "tofu" ? /\.(tftest\.(hcl|json)|tofutest\.hcl)$/ : /\.tftest\.(hcl|json)$/;
  const out: string[] = [];
  for (const sub of ["", "tests"]) {
    const at = join(dir, sub);
    if (!existsSync(at)) continue;
    for (const f of readdirSync(at).sort()) if (pattern.test(f)) out.push(sub ? `${sub}/${f}` : f);
  }
  return out;
}

/** Runs a command in a module's directory; the exit status and the output. */
export type TestRunner = (binary: string, args: string[], dir: string) => { status: number; output: string };

/** The publish job's signing key and registry login, which a module's tests have no use for. */
const PUBLISH_SECRETS = ["COSIGN_PRIVATE_KEY", "COSIGN_PASSWORD", "TERRAGUCCI_REGISTRY_USER", "TERRAGUCCI_REGISTRY_PASSWORD"];

export const spawnRunner: TestRunner = (binary, args, dir) => {
  const env = binaryEnv({ ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" });
  for (const k of PUBLISH_SECRETS) delete env[k];
  const r = spawnSync(binary, args, { cwd: dir, encoding: "utf-8", env, maxBuffer: 1 << 28 });
  if (r.error) return { status: 127, output: `${binary}: ${r.error.message}` };
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/** The last lines of a run's output, for a refusal. */
const tail = (output: string, lines = 15): string => output.trim().split("\n").slice(-lines).join("\n");

/** Test one module. Undefined when it passed; else why the release is refused. */
export function testModule(dir: string, rel: string, binary: TestBinary, run: TestRunner = spawnRunner): string | undefined {
  const files = testFiles(dir, binary);
  if (files.length === 0) {
    return `${rel} has no tests (no *.tftest.hcl in it or its tests directory), and modules.test publishes only a release whose tests pass`;
  }
  const init = run(binary, ["init", "-backend=false", "-input=false", "-no-color"], dir);
  if (init.status !== 0) return `${binary} init failed in ${rel}, so its tests could not run:\n${tail(init.output)}`;
  const test = run(binary, ["test", "-no-color"], dir);
  if (test.status !== 0) return `${binary} test failed in ${rel}:\n${tail(test.output)}`;
  return undefined;
}
