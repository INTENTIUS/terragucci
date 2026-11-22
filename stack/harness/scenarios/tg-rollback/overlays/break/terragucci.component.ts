// Written by terragucci init from promotion in terragucci.yml: each root of an environment as a chant component.
// BREAK: staging's step applies dev's root, so a promote to staging plans and applies dev's files under staging.
// Approved once, at the stage's gate in .chant/pipeline.ts: staging, prod; terragucci approve release <env>
import type { Component } from "@intentius/chant/components";

const NO_ROLLBACK = "a root goes back by deploying an earlier release: terragucci rollback <env> --release <label>";

export const root_envs_net: Component = { name: "envs-net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", noRollback: NO_ROLLBACK, environments: { "dev": { root: "envs/dev/net" }, "staging": { root: "envs/dev/net" }, "prod": { root: "envs/prod/net" } } }] }] };
