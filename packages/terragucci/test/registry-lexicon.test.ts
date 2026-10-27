// The module registry protocol moved to chant's terraform lexicon (chant#4565). terragucci's publish/registry.ts calls
// the lexicon's writer and reader when the installed chant carries `/registry`, and its own copies when it does not.
// Each case either makes the part missing, stands a module in for it, or runs only when the installed chant has it.
import { afterEach, describe, expect, it } from "vitest";
import { chantNextParts, chantRegistry, overrideChantNext, type ChantRegistry } from "../src/chant-next";
import { dirStore, registryAddress, registryLocation, registryVersions, RegistryError, writeVersion, downloadDoc } from "../src/publish/registry";
import { tmp } from "./helpers";

const parts = await chantNextParts();
const REG = { url: "https://modules.test", namespace: "acme", dir: "public" };

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

const files = (location: string) => ({
  download: { key: "v1/modules/acme/net/generic/0.1.0/download", body: downloadDoc(location) },
  meta: { key: "v1/modules/acme/net/generic/0.1.0/release.json", body: "{}\n" },
});

describe("registry protocol from the lexicon", () => {
  it("writes with its own copy when the installed chant has no /registry", async () => {
    restore.push(overrideChantNext("registry", null));
    const store = dirStore(tmp());
    const addr = registryAddress(REG, "modules/net");
    await writeVersion(store, REG, addr, { major: 0, minor: 1, patch: 0 }, files("https://modules.test/x.tar.gz"));
    expect((await store.read("v1/modules/acme/net/generic/versions")).body).toContain('"0.1.0"');
  });

  it("hands the writer and the reader to the lexicon when it is there, and keeps one error class", async () => {
    const calls: string[] = [];
    class RegistryErrorFromChant extends Error {
      constructor(m: string) {
        super(m);
        this.name = "RegistryError";
      }
    }
    const stand = {
      async writeVersion(_s, _a, _v, _f, o) {
        calls.push(`write prefix=${o?.prefix ?? ""}`);
      },
      async registryVersions(source) {
        calls.push(`versions ${source}`);
        return ["0.1.0"];
      },
      async registryLocation() {
        throw new RegistryErrorFromChant("names no location");
      },
      async fetchTarball() {
        return Buffer.from("");
      },
    } as Partial<ChantRegistry> as ChantRegistry;
    restore.push(overrideChantNext("registry", stand));
    const addr = registryAddress(REG, "modules/net");
    await writeVersion(dirStore(tmp()), { ...REG, prefix: "registry" }, addr, { major: 0, minor: 1, patch: 0 }, files("https://modules.test/x.tar.gz"));
    expect(await registryVersions("modules.test/acme/net/generic")).toEqual(["0.1.0"]);
    await expect(registryLocation("modules.test/acme/net/generic", "0.1.0")).rejects.toBeInstanceOf(RegistryError);
    expect(calls).toEqual(["write prefix=registry", "versions modules.test/acme/net/generic"]);
  });

  it.runIf(parts.registry)("answers a download with X-Terraform-Get, so Terraform reads it (terragucci#1287)", async () => {
    const lexicon = (await chantRegistry())!;
    const answer = lexicon.downloadAnswer("https://modules.test/x.tar.gz");
    expect(answer.status).toBe(200);
    expect(answer.headers["X-Terraform-Get"]).toBe("https://modules.test/x.tar.gz");
    expect(JSON.parse(answer.body)).toEqual({ location: "https://modules.test/x.tar.gz" });
  });
});
