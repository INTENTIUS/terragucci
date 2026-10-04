/**
 * Module pins: which calls in a root name the module, where each one's pin
 * stands, and the edit that moves it.
 *
 * chant's pin edit does the reading and the writing (`readModulePin`,
 * `editPins`): it parses the file, rewrites only the literal that holds the
 * pin, and re-reads the result to prove nothing else moved. This file decides
 * which calls a `terragucci rollout <module> <version>` means, and what the
 * new pin is for each.
 *
 * The module is named by its source without the pin, or by the end of that
 * source's path, so `modules/network` names
 * `oci://registry.example.com/acme/modules/network?tag=1.3.0` and
 * `git::https://example.com/acme/infra.git//modules/network?ref=modules/network/v1.3.0`.
 * The version keeps the shape of the pin it replaces: a ref of
 * `modules/network/v1.3.0` moves to `modules/network/v1.4.0`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { editPins, isTerragruntFile, readModulePin, type ModuleCallPin } from "@intentius/chant-lexicon-terraform/pin";

/** One module call that names the module. */
export interface ModuleCall {
  /** The file, relative to the repository. */
  file: string;
  /** `module.<name>`, or `terraform` in a `terragrunt.hcl`. */
  call: string;
  pin: ModuleCallPin;
  /** The version part of the pin (`1.3.0` of `modules/network/v1.3.0`), or the pin itself. */
  version: string | null;
}

const VERSION_TAIL = /^(.*?)(v?)(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** The version a pin carries at its end, or the whole pin when it has none (a digest, a branch). */
export function pinVersion(pin: string): string {
  return VERSION_TAIL.exec(pin)?.[3] ?? pin;
}

/** The pin `to` makes in the shape of `pin`: the same prefix, and the same `v` when `to` has none. */
export function shapePin(pin: string, to: string): string {
  const m = VERSION_TAIL.exec(pin);
  if (!m || !/^v?\d/.test(to)) return to;
  return m[1] + (to.startsWith("v") ? to : m[2] + to);
}

/** Whether a call's module (its source without the pin) is the one asked for. */
export function namesModule(identity: string, wanted: string): boolean {
  const w = wanted.replace(/^\.\//, "").replace(/\/+$/, "");
  if (identity === w) return true;
  if (/^(oci|git|https?|s3|gcs|tfr):|::|^[a-z0-9.-]+\.[a-z]{2,}\//i.test(w)) return readModulePin(w).module === identity;
  const base = identity.split("?")[0]!.replace(/\/+$/, "");
  return base.endsWith(`/${w}`);
}

/** The files the pin edit reads in a root: its `.tf` files and its `terragrunt.hcl`. */
export function pinFiles(repo: string, root: string): string[] {
  const dir = join(repo, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf") || f === "terragrunt.hcl")
    .sort()
    .map((f) => (root === "." ? f : posix.join(root, f)));
}

/** Every call in a root that names the module. */
export async function moduleCalls(repo: string, root: string, wanted: string, parser: Hcl2Json): Promise<ModuleCall[]> {
  const out: ModuleCall[] = [];
  for (const file of pinFiles(repo, root)) {
    const text = readFileSync(join(repo, file), "utf-8");
    const tree = (await parser.parse(file, text)) as Record<string, unknown>;
    const bodies: Array<[string, Record<string, unknown>]> = [];
    if (isTerragruntFile(file)) {
      for (const b of (tree.terraform as Record<string, unknown>[] | undefined) ?? []) bodies.push(["terraform", b]);
    } else {
      for (const [name, list] of Object.entries((tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {})) {
        for (const b of list) bodies.push([`module.${name}`, b]);
      }
    }
    for (const [call, body] of bodies) {
      if (typeof body.source !== "string") continue;
      const pin = readModulePin(body.source, typeof body.version === "string" ? body.version : undefined);
      if (!namesModule(pin.module, wanted)) continue;
      out.push({ file, call, pin, version: pin.pin === null ? null : pinVersion(pin.pin) });
    }
  }
  return out;
}

/**
 * Move every call at `from` to `to` in one root. Returns the edited files, or
 * the reason a call could not move.
 */
export async function movePins(
  repo: string,
  calls: ModuleCall[],
  from: string,
  to: string,
  parser: Hcl2Json,
): Promise<{ edits: Map<string, string> } | { refused: string }> {
  const edits = new Map<string, string>();
  const moving = calls.filter((c) => c.pin.pin !== null && (c.version === from || c.pin.pin === from));
  for (const file of [...new Set(moving.map((c) => c.file))]) {
    let text = readFileSync(join(repo, file), "utf-8");
    const requests = new Map<string, { module: string; from: string; to: string }>();
    for (const c of moving.filter((m) => m.file === file)) {
      const req = { module: c.pin.module, from: c.pin.pin!, to: shapePin(c.pin.pin!, to) };
      requests.set(JSON.stringify(req), req);
    }
    for (const req of requests.values()) {
      const result = await editPins(text, file, req, parser);
      const refused = result.calls.find((c) => c.outcome === "refused");
      if (refused && "reason" in refused) return { refused: `${file} ${refused.call}: ${refused.reason}` };
      text = result.content;
    }
    edits.set(file, text);
  }
  return { edits };
}
