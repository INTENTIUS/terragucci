import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_PINS, tagComments, unpinnedActions } from "../src/action-pins";
import { agentCommentInput, agentDriftInput } from "../src/agent-comment";
import { validateConfig } from "../src/config";
import { renderPipeline } from "../src/render";
import { reviewInput } from "../src/review-agent";

const OIDC = { plan_role: "arn:aws:iam::111:role/plan-ro", apply_role: "arn:aws:iam::111:role/apply-rw" };
const layers = [["network"], ["app"]];
const base = { via: "forge", token_env: "AGENT_FORGE_TOKEN" };

/** Every file a renderer writes for the forge, with the features that add jobs and files of their own. */
function rendered(forge: "github" | "forgejo"): { path: string; content: string }[] {
  const comment = agentCommentInput(validateConfig({ agent: { ...base, comment: { max_turns: 12, timeout: 20 } }, policy: { path: "rego" } }, "t"))!;
  const drift = agentDriftInput(validateConfig({ drift: "0 6 * * *", respond: { drift: "off" }, agent: { ...base, drift: { max_turns: 12, timeout: 20 } }, policy: { path: "rego" } }, "t"))!;
  const review = reviewInput(validateConfig({ review: { agent: true, key_secret: "REVIEW_KEY", instructions: "docs/review.md", timeout: 7 } }, "t"))!;
  const common = { forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC } as const;
  const files: { path: string; content: string }[] = [];
  for (const input of [
    { ...common, drift: "0 6 * * *", respond: { drift: "off" }, agentDrift: drift, agentComment: comment, review, gate: "always", resume: 10 },
    { ...common, ephemeral: { sweep: 15 } },
  ]) {
    const r = renderPipeline(input as never);
    files.push({ path: r.path, content: r.content }, ...(r.extra ?? []));
  }
  return files;
}

describe("the actions a rendered workflow uses", () => {
  for (const forge of ["github", "forgejo"] as const) {
    it(`are each pinned by commit SHA on ${forge}, with the release beside it`, () => {
      const files = rendered(forge);
      expect(files.length).toBeGreaterThan(3);
      for (const f of files) expect({ path: f.path, unpinned: unpinnedActions(f.content) }).toEqual({ path: f.path, unpinned: [] });
      const all = files.map((f) => f.content).join("\n");
      expect(all).toMatch(new RegExp(`uses: \\S*actions/checkout@${ACTION_PINS.checkout.sha} # ${ACTION_PINS.checkout.tag}$`, "m"));
      const upload = forge === "forgejo" ? ACTION_PINS.uploadArtifactV3 : ACTION_PINS.uploadArtifact;
      expect(all).toContain(`actions/upload-artifact@${upload.sha} # ${upload.tag}`);
      if (forge === "forgejo") expect(all).toContain(`https://code.forgejo.org/actions/checkout@${ACTION_PINS.checkout.sha}`);
    });
  }

  it("name no action by tag or branch anywhere in the renderers' sources, outside the pin table", () => {
    const dir = join(__dirname, "../src");
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && e.name !== "action-pins.ts") {
          for (const m of readFileSync(p, "utf8").matchAll(/["'`]((?:actions|docker|aws-actions|google-github-actions|azure|hashicorp)\/[\w./-]+@[\w.-]+)["'`]/g)) if (!/@[0-9a-f]{40}$/.test(m[1])) found.push(`${p.slice(dir.length + 1)}: ${m[1]}`);
        }
      }
    };
    walk(dir);
    expect(found).toEqual([]);
  });

  it("finds a tag, a branch or a short SHA, and passes a full SHA, a local action and a docker image", () => {
    const yaml = [
      "      - uses: actions/checkout@v4",
      "        uses: https://code.forgejo.org/actions/cache@main",
      "      - uses: 'actions/setup-node@8207627'",
      `      - uses: actions/checkout@${"a".repeat(40)} # v4.4.0`,
      "      - uses: ./.github/actions/local",
      "      - uses: docker://alpine:3.20",
    ].join("\n");
    expect(unpinnedActions(yaml)).toEqual(["actions/checkout@v4", "https://code.forgejo.org/actions/cache@main", "actions/setup-node@8207627"]);
  });

  it("writes the release beside a pinned line once, and leaves an unknown SHA alone", () => {
    const line = `      - uses: actions/checkout@${ACTION_PINS.checkout.sha}`;
    const once = tagComments(line);
    expect(once).toBe(`${line} # ${ACTION_PINS.checkout.tag}`);
    expect(tagComments(once)).toBe(once);
    expect(tagComments(`  uses: actions/checkout@${"f".repeat(40)}`)).toBe(`  uses: actions/checkout@${"f".repeat(40)}`);
  });
});
