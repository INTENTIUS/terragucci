import { describe, expect, it } from "vitest";
import { configFromEntries, estateClaims, putEntryAt, type ControlEntry } from "../src/control-records";
import { checkOwnership, controlClaimsAt, projectKeyFromEnv } from "../src/estate-ownership";
import { git, tmp } from "./helpers";

const entry = (project: string, estates: string[]): ControlEntry => ({ id: project, path: "", digest: "", entry: "project", project, settings: {}, estates });

/** A control repo with one commit on main, so chant can put its ledger beside it. */
function controlRepo(): string {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

describe("control entries: the config they stand for", () => {
  it("reads active entries into the config terragucci.yml held, projects sorted", () => {
    const cfg = configFromEntries([
      { id: "ctl-001", path: "", digest: "", entry: "defaults", settings: { gate: "always" }, estates: [] },
      { ...entry("github.com/acme/web", []), settings: { binary: "tofu" } },
      entry("github.com/acme/api", []),
    ]);
    expect(cfg.defaults).toEqual({ gate: "always" });
    expect(Object.keys(cfg.projects!)).toEqual(["github.com/acme/api", "github.com/acme/web"]);
  });
});

describe("estate ownership: resolved at each plan", () => {
  const claims = estateClaims([entry("github.com/acme/net", ["net"]), entry("github.com/acme/app", ["app"])]);

  it("names the owner of an estate a root reads from another project", () => {
    const r = checkOwnership({ self: "github.com/acme/app", local: new Map([["app", "envs/app"]]), reads: new Map([["envs/app", [{ name: "net", estate: "net" }]]]), claims });
    expect(r.refusals).toEqual([]);
    expect(r.owners.get("net")).toBe("github.com/acme/net");
    expect(r.notes[0]).toContain("owned by github.com/acme/net");
  });

  it("notes a read nobody owns, and does not stop the plan", () => {
    const r = checkOwnership({ self: "github.com/acme/app", local: new Map(), reads: new Map([["envs/app", [{ name: "x", estate: "ghost" }]]]), claims });
    expect(r.refusals).toEqual([]);
    expect(r.notes[0]).toContain("no project");
  });

  it("refuses an estate two projects claim, and one the entries give to another project", () => {
    const both = estateClaims([entry("github.com/acme/net", ["net"]), entry("github.com/acme/app", ["net"])]);
    expect(checkOwnership({ local: new Map(), reads: new Map(), claims: both }).refusals[0]).toMatch(/claimed by .* and /);
    const r = checkOwnership({ self: "github.com/acme/app", local: new Map([["net", "envs/net"]]), reads: new Map(), claims });
    expect(r.refusals[0]).toContain("owns estate net");
    expect(r.refusals[0]).toContain("github.com/acme/net");
  });

  it("reads the ledger at the time of each call, not once", async () => {
    const dir = controlRepo();
    const env = { TERRAGUCCI_CONTROL_DIR: dir };
    expect((await controlClaimsAt(undefined, env))!.size).toBe(0);
    await putEntryAt(dir, { entry: "project", project: "github.com/acme/net", settings: {}, estates: ["net"] });
    expect((await controlClaimsAt(undefined, env))!.get("net")).toEqual(["github.com/acme/net"]);
  });

  it("has nothing to ask without a checkout or a read token", async () => {
    expect(await controlClaimsAt({ repo: "github.com/acme/control", op: "deploy" }, {})).toBeUndefined();
  });

  it("clones the control repo with the read token, fetches its chant/lifecycle, and never prints the token", async () => {
    const src = controlRepo();
    await putEntryAt(src, { entry: "project", project: "github.com/acme/net", settings: {}, estates: ["net"] });
    let url = "";
    const got = await controlClaimsAt(
      { repo: "github.com/acme/control", op: "deploy" },
      { TERRAGUCCI_CONTROL_READ_TOKEN: "s3cret" },
      (u, into) => {
        url = u;
        git(into, "clone", "-q", src, ".");
      },
      (into) => void git(into, "fetch", "-q", "origin", "+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle"),
    );
    expect(got!.get("net")).toEqual(["github.com/acme/net"]);
    expect(url).toContain("s3cret");
    await expect(
      controlClaimsAt({ repo: "github.com/acme/control", op: "deploy" }, { TERRAGUCCI_CONTROL_READ_TOKEN: "s3cret" }, () => {
        throw new Error("fatal: bad credentials for https://oauth2:s3cret@github.com/acme/control.git");
      }),
    ).rejects.toThrow(expect.objectContaining({ message: expect.not.stringContaining("s3cret") }));
  });

  it("knows its project from the CI environment", () => {
    expect(projectKeyFromEnv({ GITHUB_REPOSITORY: "acme/app" })).toBe("github.com/acme/app");
    expect(projectKeyFromEnv({ GITHUB_REPOSITORY: "acme/app", GITHUB_SERVER_URL: "https://git.example.com" })).toBe("git.example.com/acme/app");
    expect(projectKeyFromEnv({ CI_PROJECT_PATH: "g/s/app", CI_SERVER_HOST: "gitlab.com" })).toBe("gitlab.com/g/s/app");
    expect(projectKeyFromEnv({})).toBeUndefined();
  });
});
