// Written by terragucci init from promotion in terragucci.yml: each root of an environment as a chant component.
// BREAK: staging's component applies dev's root, so a promote to staging plans and applies dev's files under staging.
// chant-disable COMP004 -- each gate waits for a person: terragucci approve release <env>
import type { Component } from "@intentius/chant/components";

const env = process.env.CHANT_ENV;
const NO_ROLLBACK = "a root goes back by deploying an earlier release: terragucci rollback <env> --release <label>";

export const root_envs_net: Component | undefined =
  env === "dev"
    ? { name: "envs-net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "envs/dev/net", noRollback: NO_ROLLBACK }] }] }
  : env === "staging"
    ? { name: "envs-net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "staging", description: "approve with terragucci approve release staging" }, { kind: "terraform-apply", root: "envs/dev/net", noRollback: NO_ROLLBACK }] }] }
  : env === "prod"
    ? { name: "envs-net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "gate", gate: "prod", description: "approve with terragucci approve release prod" }, { kind: "terraform-apply", root: "envs/prod/net", noRollback: NO_ROLLBACK }] }] }
  : undefined;
