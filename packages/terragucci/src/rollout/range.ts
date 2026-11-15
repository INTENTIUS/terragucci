/**
 * The edit that moves a module call's `version` constraint to an exact
 * version (`terragucci pin modules`). chant's pin edit moves one exact pin to
 * another and refuses a constraint, which has no one version to move from;
 * here the constraint as written is the `from`.
 *
 * It keeps the discipline of chant's edit: the HCL reader says which calls
 * exist and what their `version` is, chant's scanner places the literal, the
 * literal has to read back as the value the reader gave, and the edited file
 * has to parse to the same tree with only the pinned values changed. Anything
 * else writes nothing.
 */
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { escapeHcl, scanBlocks, unescapeHcl } from "@intentius/chant-lexicon-terraform/pin/scan";

export interface RangeRequest {
  /** The module the call names, its source as `readModulePin` reads it. */
  module: string;
  /** The constraint as written in the call's `version`. */
  from: string;
  /** The exact version it becomes. */
  to: string;
}

export interface RangeEdit {
  content: string;
  calls: Array<{ call: string; outcome: "moved" | "refused"; reason?: string }>;
}

/** Move every call of `request.module` whose `version` reads `request.from` to `request.to`, in one `.tf` file. */
export async function pinRange(text: string, file: string, request: RangeRequest, parser: Hcl2Json): Promise<RangeEdit> {
  type Tree = Record<string, unknown>;
  const tree = (await parser.parse(file, text)) as Tree;
  const expected = structuredClone(tree);
  const blocks = scanBlocks(text, file);
  const modules = (tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {};
  const expectedModules = (expected.module as Record<string, Record<string, unknown>[]> | undefined) ?? {};
  const calls: RangeEdit["calls"] = [];
  const splices: Array<{ start: number; end: number; text: string }> = [];

  for (const [name, bodies] of Object.entries(modules)) {
    const scanned = blocks.filter((b) => b.type === "module" && b.labels.length === 1 && b.labels[0] === name);
    bodies.forEach((body, k) => {
      if (typeof body.source !== "string" || typeof body.version !== "string") return;
      if (readModulePin(body.source, body.version).module !== request.module || body.version !== request.from) return;
      const call = `module.${name}`;
      const literal = scanned[k]?.attributes.find((a) => a.name === "version")?.literal;
      if (!literal || unescapeHcl(literal.raw) !== body.version) {
        calls.push({ call, outcome: "refused", reason: "version is not a plain string literal, so there is no one place to write the pin" });
        return;
      }
      splices.push({ start: literal.start, end: literal.end, text: escapeHcl(request.to) });
      expectedModules[name]![k]!.version = request.to;
      calls.push({ call, outcome: "moved" });
    });
  }

  let content = text;
  for (const s of splices.sort((a, b) => b.start - a.start)) content = content.slice(0, s.start) + s.text + content.slice(s.end);
  if (splices.length > 0) {
    const reread = (await parser.parse(file, content)) as Tree;
    if (JSON.stringify(reread) !== JSON.stringify(expected)) throw new Error(`${file}: the pin edit would change more than the pin, so nothing was written`);
  }
  return { content, calls };
}
