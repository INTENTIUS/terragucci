// A wave that read an upstream output unknown at review plans again once the upstream applied (Linked roots). chant's
// coveredRound decides whether the pull request's plan covers that plan (terragucci#1268): only the inputs it previewed
// as known after apply may differ, and anything else stops for a new approval with planShapeCovers's reason.
import { describe, expect, it } from "vitest";
import { unknownInputs, waveCoverage } from "../src/covered-wave";
import type { UnknownRead } from "../src/unknown-reads";

const unknown: UnknownRead[] = [{ root: "app", upstream: "network", wave: 1, outputs: ["subnet_id"], carrier: "pull-request", from: "pull request 7's plan of abcdef12" }];

const instance = (subnet: string | undefined, extra: Record<string, unknown> = {}) => ({
  address: "aws_instance.web",
  mode: "managed",
  type: "aws_instance",
  name: "web",
  change: {
    actions: ["update"],
    before: { ami: "ami-1", subnet_id: "subnet-old", tags: {} },
    after: { ami: "ami-1", subnet_id: subnet ?? null, tags: {}, ...extra },
    after_unknown: subnet === undefined ? { subnet_id: true } : {},
  },
});

const plan = (...changes: unknown[]) => ({ format_version: "1.2", resource_changes: changes });

describe("a covered round of linked roots", () => {
  it("names the inputs a root was previewed without", () => {
    expect(unknownInputs("app", unknown)).toEqual(["network.subnet_id"]);
    expect(unknownInputs("app", [{ ...unknown[0]!, outputs: [] }])).toEqual(["network"]);
    expect(unknownInputs("edge", unknown)).toEqual([]);
  });

  it("is covered when only the input previewed as known after apply is filled in", () => {
    const cover = waveCoverage([{ root: "app", previewed: plan(instance(undefined)), fresh: plan(instance("subnet-new")) }], unknown, "sha256:note");
    expect(cover).toEqual({ covered: true, digest: "sha256:note", filledInputs: ["network.subnet_id"] });
  });

  it("is not covered when the plan touches a resource the pull request's did not, and says why", () => {
    const more = { ...instance("subnet-new"), address: "aws_instance.extra", name: "extra" };
    const cover = waveCoverage([{ root: "app", previewed: plan(instance(undefined)), fresh: plan(instance("subnet-new"), more) }], unknown, "sha256:note");
    expect(cover.covered).toBe(false);
    expect(cover.covered ? "" : cover.reason).toMatch(/aws_instance\.extra/);
  });

  it("is not covered when a property no unknown input drives changes", () => {
    const cover = waveCoverage([{ root: "app", previewed: plan(instance(undefined)), fresh: plan(instance("subnet-new", { ami: "ami-2" })) }], unknown, "sha256:note");
    expect(cover.covered).toBe(false);
  });

  it("is not covered when the pull request's plan of a root cannot be read", () => {
    const cover = waveCoverage([{ root: "app", fresh: plan(instance("subnet-new")) }], unknown, "sha256:note");
    expect(cover).toEqual({ covered: false, reason: expect.stringMatching(/could not be read/) });
  });
});
