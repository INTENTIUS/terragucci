// The module registry protocol is chant's terraform lexicon's (chant#4565). terragucci's publish/registry.ts calls
// the lexicon's writer and reader with its own settings mapped in.
import { describe, expect, it } from "vitest";
import { downloadAnswer } from "@intentius/chant-lexicon-terraform/registry";
import { dirStore, registryAddress, registryLocation, RegistryError, writeVersion, downloadDoc } from "../src/publish/registry";
import { tmp } from "./helpers";

const REG = { url: "https://modules.test", namespace: "acme", dir: "public" };

const files = (location: string) => ({
  download: { key: "v1/modules/acme/net/generic/0.1.0/download", body: downloadDoc(location) },
  meta: { key: "v1/modules/acme/net/generic/0.1.0/release.json", body: "{}\n" },
});

describe("registry protocol from the lexicon", () => {
  it("writes the versions list under the registry's prefix", async () => {
    const store = dirStore(tmp());
    const addr = registryAddress(REG, "modules/net");
    await writeVersion(store, { ...REG, prefix: "registry" }, addr, { major: 0, minor: 1, patch: 0 }, files("https://modules.test/x.tar.gz"));
    expect((await store.read("registry/v1/modules/acme/net/generic/versions")).body).toContain('"0.1.0"');
    expect((await store.read("registry/.well-known/terraform.json")).body).toContain("modules.v1");
  });

  it("throws the lexicon's RegistryError, which terragucci re-exports, on a download that names no location", async () => {
    const fetch = (async (url: string) =>
      url.endsWith("terraform.json") ? new Response(JSON.stringify({ "modules.v1": "/v1/modules/" })) : new Response("{}", { status: 200 })) as never;
    await expect(registryLocation("modules.test/acme/net/generic", "0.1.0", fetch)).rejects.toBeInstanceOf(RegistryError);
  });

  it("answers a download with X-Terraform-Get, so Terraform reads it (terragucci#1287)", () => {
    const answer = downloadAnswer("https://modules.test/x.tar.gz");
    expect(answer.status).toBe(200);
    expect(answer.headers["X-Terraform-Get"]).toBe("https://modules.test/x.tar.gz");
    expect(JSON.parse(answer.body)).toEqual({ location: "https://modules.test/x.tar.gz" });
  });
});
