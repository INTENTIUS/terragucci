/**
 * choudoufu estates planned on an upstream's planned outputs. A root whose
 * `data "terraform_estate_outputs"` block reads the estate another root of
 * the run owns plans, in a pull request, with `-estate-outputs-from
 * <estate>=<file>`, the file being the upstream's `show -json` from this
 * run: choudoufu answers the read from that plan instead of from what the
 * upstream recorded at its last apply. Nothing in the root's files changes,
 * unlike a plain root's linked plan (./linked.ts).
 *
 * choudoufu refuses a read of an output the upstream's plan knows only once
 * it applies, or of a sensitive one, and plans nothing. terragucci reads the
 * refusal from the plan's diagnostics (`estateRefusals`): an unknown output
 * leaves the root unplanned until the upstream's wave applies, named with the
 * output and that wave; a sensitive one fails the root, since choudoufu never
 * hands a sensitive output to another estate, planned or recorded.
 *
 * That plan is for review. The apply wave plans again on the outputs the
 * upstream's wave recorded, with no `-estate-outputs-from`, so choudoufu's
 * apply-time check of a plan made on planned outputs (exit 3 until the
 * upstream has applied them) never meets a plan terragucci applies.
 *
 * `-estate-outputs-from` and `plan -cone` never go together: choudoufu plans
 * every reader in full under `-estate-outputs-from` anyway.
 */
import type { ReportRead } from "./report/schema";
import { plannedOutputs } from "./planned-outputs";

/** One `data "terraform_estate_outputs"` block of a root: its label and the estate it reads. */
export interface EstateRead {
  name: string;
  estate: string;
}

/** The flag that hands a plan the upstream estate's planned outputs, in the form choudoufu's own live-plan-set passes it. */
export const estateOutputsFromArg = (estate: string, file: string): string => `-estate-outputs-from=${estate}=${file}`;

/**
 * How a root plans on the estates it reads: the `-estate-outputs-from`
 * arguments, one per estate (choudoufu refuses an estate named twice), the
 * reads the report names, and the upstream root of each estate handed over.
 *
 * `owner` is each estate's root in the project; a block that reads an estate
 * no root here owns, or the root's own, is left out, as a plain root's read
 * of another project's state is. `planned` is whether the run plans a root;
 * `planOf` is the upstream's plan this run made, with the `show -json` file
 * holding it.
 */
export function estateLinks(
  root: string,
  reads: readonly EstateRead[],
  owner: ReadonlyMap<string, string>,
  planned: (root: string) => boolean,
  planOf: (root: string) => { plan: unknown; file: string } | undefined,
): { args: string[]; reads: ReportRead[]; upstreamOf: Map<string, string> } {
  const args: string[] = [];
  const out: ReportRead[] = [];
  const upstreamOf = new Map<string, string>();
  for (const b of reads) {
    const up = owner.get(b.estate);
    if (!up || up === root) continue;
    const applied = (why: string): void => void out.push({ upstream: up, data: b.name, outputs: "applied", why });
    if (!planned(up)) {
      applied("this change does not reach it, so its records stand");
      continue;
    }
    const p = planOf(up);
    if (!p) {
      applied("it did not plan in this run");
      continue;
    }
    const outputs = plannedOutputs(p.plan);
    if (!outputs) applied("its plan names no output changes");
    else if (!outputs.changed) applied("its plan changes no output, so its records stand");
    else {
      out.push({ upstream: up, data: b.name, outputs: "planned" });
      if (!upstreamOf.has(b.estate)) {
        upstreamOf.set(b.estate, up);
        args.push(estateOutputsFromArg(b.estate, p.file));
      }
    }
  }
  return { args, reads: out, upstreamOf };
}

/** One read choudoufu refused from an upstream's plan: an output known only once it applies, or a sensitive one. */
export interface EstateRefusal {
  kind: "unknown" | "sensitive";
  estate: string;
  output: string;
}

/**
 * The reads a plan's diagnostics say choudoufu refused under
 * `-estate-outputs-from`, in the order they appear, each once. The
 * diagnostic's detail is word-wrapped to the terminal's width, so the text is
 * read with its lines joined.
 */
export function estateRefusals(text: string): EstateRefusal[] {
  const flat = text.replace(/^[ \t]*[│╷╵]/gm, " ").replace(/\s+/g, " ");
  const found: EstateRefusal[] = [];
  const re = /Estate "([^"]+)"'s planned output "([^"]+)" \(in .*?\) is (known only after|sensitive)/g;
  for (const m of flat.matchAll(re)) {
    const r: EstateRefusal = { kind: m[3] === "sensitive" ? "sensitive" : "unknown", estate: m[1]!, output: m[2]! };
    if (!found.some((f) => f.kind === r.kind && f.estate === r.estate && f.output === r.output)) found.push(r);
  }
  return found;
}

const tick = (s: string): string => "`" + s + "`";

/**
 * Why a root whose read choudoufu refused as unknown is not planned: the
 * outputs, the upstream roots, and the waves that settle them, as a
 * Terragrunt unit's note says it (`reads `out` of live/app, unknown until
 * wave 2 applies`).
 */
export function unknownWhy(refused: readonly EstateRefusal[], upstreamOf: ReadonlyMap<string, string>, settles: readonly number[]): string {
  const outputs = [...new Set(refused.map((r) => r.output))].sort();
  const ups = [...new Set(refused.map((r) => upstreamOf.get(r.estate) ?? r.estate))].sort();
  return `reads ${outputs.map(tick).join(", ")} of ${ups.join(", ")}, unknown until ${settles.length ? `wave ${settles.join(", ")}` : "it"} applies`;
}

/** Why a root whose read choudoufu refused as sensitive fails. */
export function sensitiveWhy(refused: readonly EstateRefusal[], upstreamOf: ReadonlyMap<string, string>): string {
  const outputs = [...new Set(refused.map((r) => r.output))].sort();
  const ups = [...new Set(refused.map((r) => upstreamOf.get(r.estate) ?? r.estate))].sort();
  return `reads sensitive ${outputs.length === 1 ? "output" : "outputs"} ${outputs.map(tick).join(", ")} of ${ups.join(", ")}, which choudoufu never hands to another estate`;
}
