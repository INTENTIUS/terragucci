/**
 * floci, Forgejo and forgejo-runner for the validation stack, taken from
 * chant's e2e harness (chant#4587, terragucci#1295) under terragucci's own
 * names, ports and profiles. stack/docker-compose.yml holds every other
 * service; stack/instance.sh's tg_compose runs the two files as one project.
 *
 * Built by `stack/harness/harness.ts compose` into the instance's state
 * directory, with TG_PROJECT set: every name carries the project, as the
 * services in docker-compose.yml do through ${TG_PROJECT}. The images come
 * from the harness's pins (pins.ts), so floci moves when chant's pin moves.
 *
 * It needs a chant with `@intentius/chant/e2e-harness`. On a chant without
 * it, harness.ts never builds this project and stack/forge-fallback.yml,
 * the services as terragucci ran them before the harness, stands in.
 */
import { Network, Service, Volume, composeKey } from "@intentius/chant-lexicon-docker";
import { harnessStack } from "@intentius/chant/e2e-harness";
import { forgeServices } from "../stack-spec";

const project = process.env.TG_PROJECT || "terragucci";
const h = forgeServices(harnessStack, {
  project,
  flociImage: process.env.TERRAGUCCI_FLOCI_IMAGE || undefined,
  bindAll: process.env.TERRAGUCCI_BIND === "all",
});

// The keys stack/docker-compose.yml already uses, so the two files merge into
// one network and one set of volumes.
export const network = composeKey("default", new Network(h.network));
export const forgejoData = composeKey("forgejo-data", new Volume(h.volumes["forgejo-data"]));
export const forgejoRunnerData = composeKey("forgejo-runner-data", new Volume(h.volumes["forgejo-runner-data"]));
export const jobCache = composeKey("job-cache", new Volume(h.volumes["job-cache"]));

export const floci = new Service(h.services.floci);
export const forgejo = new Service(h.services.forgejo);
export const forgejoRunner = composeKey("forgejo-runner", new Service(h.services["forgejo-runner"]));
