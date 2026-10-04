/**
 * The HCL reader the pin edit uses, `@cdktn/hcl2json`. It carries a 1.8 MB
 * wasm parser, so it is not bundled: a rollout that reads module pins loads
 * it from the project, the way a `.ts` config loads the TypeScript folder.
 */
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { ConfigError } from "../config";

export const HCL_INSTALL = "npm i -D @cdktn/hcl2json";

export async function loadHclParser(): Promise<Hcl2Json> {
  try {
    return (await import("@cdktn/hcl2json")) as unknown as Hcl2Json;
  } catch {
    throw new ConfigError(`terragucci rollout reads module pins with the HCL parser, which is not installed: ${HCL_INSTALL}`);
  }
}
