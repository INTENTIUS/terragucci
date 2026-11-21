/**
 * terragucci.yml takes the keys of chant's product vocabulary and keeps
 * reading each earlier spelling. The warnings and the errors for a pair are
 * chant's `productConfigProblems`.
 */

import { describe, expect, it } from "vitest";
import { PRODUCT_CONFIG_WORDS_FLOOR } from "@intentius/chant/ci-product";
import { ConfigError, configWarnings, validateConfig } from "../src/config";
import { configSchemaProblems } from "../src/config-schema";

const ROLES = { plan_role: "arn:aws:iam::111122223333:role/plan", apply_role: "arn:aws:iam::111122223333:role/apply" };

describe("terragucci.yml and chant's vocabulary", () => {
  it("has the floor that carries the vocabulary", () => {
    expect(typeof PRODUCT_CONFIG_WORDS_FLOOR).toBe("string");
  });

  it("reads the vocabulary's keys with no warning, as the spellings the rest of terragucci reads", () => {
    const config = validateConfig(
      {
        identity: ROLES,
        forge_url: "https://git.example.com:3000/acme/infra",
        branches: { release: ["envs/prod/*"] },
        locks: { when: "plan" },
        drift: { schedule: "17 4 * * *" },
        notify: { teams: "TEAMS_URL", relay_name: "terragucci", relay_key: "RELAY_KEY" },
      },
      "terragucci.yml",
    );
    expect(configWarnings(config)).toEqual([]);
    expect(config.oidc).toEqual(ROLES);
    expect(config.url).toBe("https://git.example.com:3000/acme/infra");
    expect(config.apply?.branches).toEqual({ release: ["envs/prod/*"] });
    expect(config.locks).toBe("plan");
    expect(config.drift).toBe("17 4 * * *");
    expect(config.notify).toEqual({ teams: "TEAMS_URL", relay: "terragucci", relay_key: "RELAY_KEY" });
    expect(configSchemaProblems(config)).toEqual([]);
  });

  it("keeps reading each earlier spelling, and warns naming the key", () => {
    const config = validateConfig(
      {
        gate: "on-destroy",
        oidc: ROLES,
        url: "https://git.example.com:3000/acme/infra",
        apply: { branches: { release: ["envs/prod/*"] } },
        locks: "plan",
        drift: "17 4 * * *",
        notify: { teams: "TEAMS_URL", relay: "terragucci", relay_key: "RELAY_KEY" },
      },
      "terragucci.yml",
    );
    expect(config.gate).toBe("on-destructive");
    expect(config.oidc).toEqual(ROLES);
    expect(config.locks).toBe("plan");
    expect(config.drift).toBe("17 4 * * *");
    const text = configWarnings(config).join("\n");
    expect(text).toMatch(/gate .*on-destructive/);
    expect(text).toMatch(/apply\.branches .*branches/);
    expect(text).toMatch(/locks .*locks\.when/);
    expect(text).toMatch(/drift .*drift\.schedule/);
    expect(text).toMatch(/oidc .*identity/);
    expect(text).toMatch(/url .*forge_url/);
    expect(text).toMatch(/notify\.relay .*notify\.relay_name/);
  });

  it("reads a control repo's defaults and projects the same way", () => {
    const config = validateConfig(
      { defaults: { identity: ROLES }, projects: { "github.com/acme/infra": { drift: { schedule: "17 4 * * *" }, forge_url: "https://git.example.com/acme/infra" } } },
      "terragucci.yml",
    );
    expect(config.defaults?.oidc).toEqual(ROLES);
    expect(config.projects?.["github.com/acme/infra"]?.drift).toBe("17 4 * * *");
  });

  it("refuses a spelling set beside its key", () => {
    expect(() => validateConfig({ oidc: ROLES, identity: ROLES }, "terragucci.yml")).toThrow(ConfigError);
    expect(() => validateConfig({ oidc: ROLES, identity: ROLES }, "terragucci.yml")).toThrow(/both set/);
    expect(() => validateConfig({ url: "https://a.example", forge_url: "https://b.example" }, "terragucci.yml")).toThrow(/both set/);
    expect(() => validateConfig({ apply: { branches: { a: ["x"] } }, branches: { b: ["y"] } }, "terragucci.yml")).toThrow(/both set/);
  });
});
