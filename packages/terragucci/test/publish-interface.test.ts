/**
 * tf-publish refuses a bump smaller than the module's interface change since
 * its previous release (terragucci#936).
 */
import { describe, expect, it } from "vitest";
import { publish } from "../src/publish";
import { interfaceAt, interfaceBump, interfaceChanges, readInterface } from "../src/publish/interface";
import { git, tmp, write } from "./helpers";
import { fakeRegistry } from "./registry";

const iface = (text: string, name = "main.tf") => readInterface([{ name, text }]);
const changes = (before: string, after: string) => interfaceChanges(iface(before), iface(after)).map((c) => `${c.bump}: ${c.change}`);

describe("reading a module's interface", () => {
  it("reads each variable's type, default and nullable, and the outputs, past comments and nested blocks", () => {
    const i = iface(`
# variable "commented" {}
variable "name" {
  type = string
}
variable "tags" {
  type = map(
    string
  )
  default = {}
  validation {
    condition     = length(var.tags) < 10
    error_message = "too many"
  }
}
variable "zone" {
  default  = null
  nullable = false
}
output "id" { value = 1 }
`);
    expect(Object.fromEntries(i.variables)).toEqual({
      name: { type: "string", optional: false, nullable: true },
      tags: { type: "map(string)", optional: true, nullable: true },
      zone: { type: "any", optional: true, nullable: false },
    });
    expect([...i.outputs]).toEqual(["id"]);
  });

  it("reads a .tf.json file", () => {
    const i = iface(JSON.stringify({ variable: { name: { type: "${string}" }, size: { default: 1 } }, output: { id: { value: 1 } } }), "main.tf.json");
    expect(i.variables.get("name")).toEqual({ type: "string", optional: false, nullable: true });
    expect(i.variables.get("size")?.optional).toBe(true);
    expect([...i.outputs]).toEqual(["id"]);
  });
});

describe("the bump an interface change needs", () => {
  it("needs a major for a removed or renamed variable or output", () => {
    expect(changes('variable "a" { default = 1 }\noutput "o" { value = 1 }', "")).toEqual(['major: variable "a" removed', 'major: output "o" removed']);
    expect(changes('variable "a" { default = 1 }', 'variable "b" { default = 1 }')).toEqual(['major: variable "a" removed', 'minor: variable "b" added with a default']);
  });

  it("needs a major for a new variable with no default", () => {
    expect(changes("", 'variable "a" {}')).toEqual(['major: variable "a" added with no default']);
  });

  it("needs a major for a default removed or nullable turned off", () => {
    expect(changes('variable "a" { default = 1 }', 'variable "a" {}')).toEqual(['major: variable "a" lost its default']);
    expect(changes('variable "a" { default = 1 }', 'variable "a" {\n  default  = 1\n  nullable = false\n}')).toEqual(['major: variable "a" turned nullable off']);
  });

  it("needs a major for a type change, except a widening to any", () => {
    expect(changes('variable "a" { type = string }', 'variable "a" { type = number }')).toEqual(['major: variable "a" changed type from string to number']);
    expect(changes('variable "a" {}', 'variable "a" { type = string }')).toEqual(['major: variable "a" changed type from any to string']);
    expect(changes('variable "a" { type = string }', 'variable "a" { type = any }')).toEqual([]);
    expect(changes('variable "a" { type = string }', 'variable "a" {}')).toEqual([]);
  });

  it("needs a minor for a new variable with a default or a new output", () => {
    expect(changes("", 'variable "a" { default = null }\noutput "o" { value = 1 }')).toEqual(['minor: variable "a" added with a default', 'minor: output "o" added']);
  });

  it("needs only a patch when the interface did not change", () => {
    const same = 'variable "a" { type = string }\nresource "null_resource" "r" {}';
    expect(interfaceBump(interfaceChanges(iface(same), iface(`${same}\n# more`)))).toBe("patch");
  });
});

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

/** A repo whose modules net and db are published once to a fake OCI registry. */
async function published(): Promise<{ repo: string; reg: ReturnType<typeof fakeRegistry> }> {
  const repo = tmp("terragucci-interface-");
  write(repo, {
    "modules/net/main.tf": 'variable "cidr" { type = string }\noutput "id" { value = 1 }\noutput "arn" { value = 2 }\n',
    "modules/db/main.tf": 'resource "null_resource" "b" {}\n',
  });
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "feat: modules");
  const reg = fakeRegistry();
  const first = await publish(repo, oci, { fetch: reg.fetch });
  expect(first.map((r) => `${r.module}@${r.version}:${r.status}`)).toEqual(["db@0.1.0:published", "net@0.1.0:published"]);
  return { repo, reg };
}

const oci = { modules: { publish: "oci://registry.test/acme/modules" } };
const dropArn = 'variable "cidr" { type = string }\noutput "id" { value = 1 }\n';

describe("tf-publish and the interface", () => {
  it("refuses a fix: that removes an output, naming it and the major it needs, and publishes the rest", async () => {
    const { repo, reg } = await published();
    write(repo, { "modules/net/main.tf": dropArn, "modules/db/main.tf": 'resource "null_resource" "c" {}\n' });
    commit(repo, "fix: tidy");
    const r = await publish(repo, oci, { fetch: reg.fetch });
    expect(r.find((x) => x.module === "db")).toMatchObject({ status: "published", version: "0.1.1" });
    const net = r.find((x) => x.module === "net")!;
    expect(net).toMatchObject({ status: "refused", version: "0.1.1" });
    expect(net.detail).toContain("the commits since 0.1.0 call for a patch, and the interface needs a major");
    expect(net.detail).toContain('output "arn" removed (major)');
    expect(net.detail).toContain("modules/net/version at 1.0.0");
    expect(reg.manifests.has("acme/modules/net:0.1.1")).toBe(false);
  });

  it("publishes the same change as a major under feat!:", async () => {
    const { repo, reg } = await published();
    write(repo, { "modules/net/main.tf": dropArn });
    commit(repo, "feat!: drop the arn output");
    const r = await publish(repo, oci, { fetch: reg.fetch });
    expect(r.find((x) => x.module === "net")).toMatchObject({ status: "published", version: "1.0.0" });
  });

  it("refuses a new optional variable under fix: as needing a minor, and takes it under feat:", async () => {
    const { repo, reg } = await published();
    write(repo, { "modules/net/vars.tf": 'variable "zone" { default = "a" }\n' });
    commit(repo, "fix: a zone");
    const refused = (await publish(repo, oci, { fetch: reg.fetch })).find((x) => x.module === "net")!;
    expect(refused.status).toBe("refused");
    expect(refused.detail).toContain('the interface needs a minor: variable "zone" added with a default (minor); publish it with a feat: commit');
    write(repo, { "modules/net/vars.tf": '# the zone to place it in\nvariable "zone" { default = "a" }\n' });
    commit(repo, "feat: a zone");
    expect((await publish(repo, oci, { fetch: reg.fetch })).find((x) => x.module === "net")).toMatchObject({ status: "published", version: "0.2.0" });
  });

  it("holds a version file to the interface too", async () => {
    const { repo, reg } = await published();
    write(repo, { "modules/net/main.tf": dropArn, "modules/net/version": "0.2.0\n" });
    commit(repo, "fix: tidy");
    const short = (await publish(repo, oci, { fetch: reg.fetch })).find((x) => x.module === "net")!;
    expect(short).toMatchObject({ status: "refused", version: "0.2.0" });
    expect(short.detail).toContain("modules/net/version says 0.2.0, a minor bump, and the interface needs a major");
    write(repo, { "modules/net/version": "1.0.0\n" });
    commit(repo, "fix: the version");
    expect((await publish(repo, oci, { fetch: reg.fetch })).find((x) => x.module === "net")).toMatchObject({ status: "published", version: "1.0.0" });
  });

  it("shows the commit bump and the interface bump in a dry run, and refuses there too", async () => {
    const { repo, reg } = await published();
    write(repo, { "modules/net/main.tf": `${dropArn}output "name" { value = 3 }\n`, "modules/db/main.tf": 'resource "null_resource" "c" {}\n' });
    commit(repo, "fix: tidy");
    const puts = reg.puts();
    const r = await publish(repo, oci, { fetch: reg.fetch, dryRun: true });
    expect(r.find((x) => x.module === "db")!.detail).toBe("dry run: would publish; commits: patch, interface: patch");
    expect(r.find((x) => x.module === "net")).toMatchObject({ status: "refused" });
    expect(r.find((x) => x.module === "net")!.detail).toMatch(/^dry run: the commits since 0\.1\.0 call for a patch, and the interface needs a major: output "arn" removed \(major\), output "name" added \(minor\);/);
    expect(reg.puts()).toBe(puts);
  });

  it("reads the previous interface at the commit the release was cut from", async () => {
    const { repo } = await published();
    const first = git(repo, "rev-parse", "HEAD").trim();
    write(repo, { "modules/net/main.tf": dropArn });
    commit(repo, "fix: tidy");
    expect([...interfaceAt(repo, first, "modules/net")!.outputs]).toEqual(["id", "arn"]);
    expect(interfaceAt(repo, first, "modules/none")).toBeUndefined();
  });
});
