/**
 * The harness's floci, Forgejo and forgejo-runner (chant#4587's
 * harnessStack) as the validation stack runs them (terragucci#1295): the
 * compose keys, ports, profiles and volumes stack/docker-compose.yml and
 * every script already use, so nothing that reaches floci:4566,
 * forgejo:3000, localhost:4580 or localhost:3300 changes.
 *
 * harnessStack is passed in, so this file imports nothing from chant and
 * compiles on a chant without the harness; ./compose/compose.ts passes the
 * real one and test/stack-harness.test.ts a stand-in.
 */

/** The service properties this file reads and writes, a subset of compose's. */
export type ServiceSpec = {
  image: string;
  container_name: string;
  profiles?: string[];
  user?: string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  working_dir?: string;
  command?: string[];
  depends_on?: Record<string, { condition: "service_started" | "service_healthy" }>;
  networks: Record<string, { aliases: string[] }>;
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number };
  restart?: string;
};

/** The part of chant's HarnessStack this file reads. */
export interface HarnessStackLike {
  project: string;
  network: { name: string };
  networkKey: string;
  volumes: { forgejoData: { name: string }; runnerData: { name: string } };
  services: { floci: ServiceSpec; forgejo: ServiceSpec; forgejoRunner: ServiceSpec };
}

export type HarnessStackFn = (o: {
  project: string;
  envPrefix?: string;
  networkKey?: string;
  ports?: { floci?: number; forgejo?: number };
  bind?: string | null;
  forgejoActions?: boolean;
  flociImage?: string;
}) => HarnessStackLike;

/** The host ports the stack has always published, moved by TERRAGUCCI_FLOCI_PORT and TERRAGUCCI_FORGEJO_PORT. */
export const STACK_PORTS = { floci: 4580, forgejo: 3300 } as const;

/** The job cache every job container mounts at /cache (bootstrap.sh's container.options). Shared by both instances. */
export const JOB_CACHE_VOLUME = "terragucci-job-cache";

/** Which profiles start each service, as stack/forge-fallback.yml has them. */
export const PROFILES = {
  floci: ["aws", "forgejo", "github", "gitlab", "fountain"],
  forgejo: ["forgejo"],
  "forgejo-runner": ["forgejo"],
} as const;

export interface ForgeServices {
  network: { name: string };
  volumes: Record<"forgejo-data" | "forgejo-runner-data" | "job-cache", { name: string }>;
  services: Record<"floci" | "forgejo" | "forgejo-runner", ServiceSpec>;
}

/** A volume mount with the harness's export-name key swapped for the stack's compose key. */
function remount(volumes: string[] | undefined, from: string, to: string): string[] {
  return (volumes ?? []).map((v) => (v.startsWith(`${from}:`) ? `${to}:${v.slice(from.length + 1)}` : v));
}

/**
 * The three services under the stack's names. `bindAll` publishes the ports
 * on every interface, as the stack did before the harness; the default is
 * the harness's 127.0.0.1.
 */
export function forgeServices(
  harnessStack: HarnessStackFn,
  o: { project: string; flociImage?: string; bindAll?: boolean },
): ForgeServices {
  const h = harnessStack({
    project: o.project,
    envPrefix: "TERRAGUCCI",
    networkKey: "default",
    ports: { ...STACK_PORTS },
    ...(o.bindAll ? { bind: null } : {}),
    ...(o.flociImage ? { flociImage: o.flociImage } : {}),
  });
  const floci: ServiceSpec = {
    ...h.services.floci,
    profiles: [...PROFILES.floci],
    // claim_choudoufu/iam and claim_forge/check start a floci of their own with enforcement on.
    environment: { ...h.services.floci.environment, FLOCI_SERVICES_IAM_ENFORCEMENT_ENABLED: "${TERRAGUCCI_FLOCI_IAM_ENFORCEMENT:-false}" },
  };
  const forgejo: ServiceSpec = {
    ...h.services.forgejo,
    profiles: [...PROFILES.forgejo],
    environment: { ...h.services.forgejo.environment, FORGEJO__server__SSH_PORT: "0" },
    volumes: remount(h.services.forgejo.volumes, "forgejoData", "forgejo-data"),
  };
  const runner: ServiceSpec = {
    ...h.services.forgejoRunner,
    profiles: [...PROFILES["forgejo-runner"]],
    volumes: [...remount(h.services.forgejoRunner.volumes, "runnerData", "forgejo-runner-data"), "job-cache:/cache"],
  };
  return {
    network: h.network,
    volumes: {
      "forgejo-data": { name: `${o.project}-forgejo-data` },
      "forgejo-runner-data": { name: `${o.project}-forgejo-runner-data` },
      "job-cache": { name: JOB_CACHE_VOLUME },
    },
    services: { floci, forgejo, "forgejo-runner": runner },
  };
}
