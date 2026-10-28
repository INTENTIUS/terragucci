/**
 * A hosted module registry as a `modules.publish` target (terragucci#1300,
 * bundle C of terragucci#1290): the terraform lexicon's module target
 * (`registry/targets`, chant#4603) wrapped as publish's own `Target`.
 *
 * The lexicon holds the host's calls, the token order and the masking; this
 * file holds what publish asks of every target. A hosted registry keeps no
 * revision or content for a version, so `latest` takes both from the
 * version's release record on the ledger (every publish writes one,
 * terragucci#1289 ruling A): the record's commit, and the content of the
 * module at that commit. A version with no record, such as one uploaded by
 * hand, takes its content from the archive the host serves and its revision
 * from the `git-tags` tag when the repo publishes both, and is refused with
 * the fix otherwise, so publish never reads the whole history as new.
 *
 * The upload is the archive the bucket registry serves and the attestation
 * signs, unchanged (ruling B). The record goes on the ledger before the
 * upload, as for an OCI tag.
 */
import type { RegistrySettings } from "../config";
import { ConfigError } from "../config";
import { chantModuleTargets, type ChantModuleAddress, type ChantModuleFetch, type ChantModuleTarget, type ChantModuleTargets, type ChantModuleVersionContext } from "../chant-next";
import { gzip, moduleTarAt, sha256 } from "./archive";
import { tryGit } from "./git";
import { readModuleLedger } from "./ledger";
import { DEFAULT_SYSTEM, registryAddress } from "./registry";
import { compareSemver, formatSemver, parseSemver, type Semver } from "./semver";

/** What publish's own targets answer; the shape publish/index.ts's `Target` takes. */
export interface HostedTarget {
  label: string;
  latest(mod: { name: string; rel: string }): Promise<{ version: Semver; revision: string; content: string } | undefined>;
  existing(mod: { name: string; rel: string }, version: Semver): Promise<{ ref: string; content: string } | undefined>;
  publish(mod: { name: string; rel: string }, version: Semver, ctx: { rel: string; revision: string; content: string; tar: Buffer; pushWithRecord?: (refs: string[]) => Promise<void> }): Promise<string>;
  subject(mod: { name: string; rel: string }, version: Semver, ctx: { tar: Buffer }): { ref: string; bytes: Buffer };
  note(mod: { name: string; rel: string }, version: Semver): string | undefined;
}

export interface HostedOptions {
  /** The repo publish runs in. */
  repo: string;
  env: NodeJS.ProcessEnv;
  /** `modules.registry`, whose namespaces and system a hosted address takes when it is set. */
  registry?: RegistrySettings;
  /** Whether `modules.publish` also lists `git-tags`, whose tags give a version with no record its revision. */
  gitTags: boolean;
  /** The fetch for the host's API and its registry reads, for tests. */
  fetch?: ChantModuleFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A hosted target the installed chant can make, given the lexicon's factories. */
export type HostedFactory = (lib: ChantModuleTargets, deps: { fetch?: ChantModuleFetch; registryFetch?: ChantModuleFetch; sleep?: (ms: number) => Promise<void>; now?: () => number }) => ChantModuleTarget;

/** The address a module goes under on a host: the registry's name and system when `modules.registry` is set, else the directory's name and `generic`. */
export function hostedAddress(reg: RegistrySettings | undefined, mod: { name: string; rel: string }, namespace: string): ChantModuleAddress {
  if (reg) {
    const a = registryAddress(reg, mod.rel);
    return { namespace, name: a.name, system: a.system };
  }
  return { namespace, name: mod.name, system: DEFAULT_SYSTEM };
}

/**
 * Wrap a lexicon module target as publish's `Target`. `make` builds it once
 * chant is loaded; `namespace` is the namespace the host's sources name, and
 * `source` how a row names a version.
 */
export function hostedTarget(label: string, make: HostedFactory, namespace: string, source: (a: ChantModuleAddress) => string, o: HostedOptions): HostedTarget {
  let made: { lib: ChantModuleTargets; target: ChantModuleTarget } | undefined;
  const target = async () => {
    if (!made) {
      const lib = await chantModuleTargets();
      if (!lib) throw new ConfigError(`modules.publish: ${label} publishes through the terraform lexicon's module targets (chant#4603), which the installed chant does not carry; it needs a chant release that does`);
      made = { lib, target: make(lib, { ...(o.fetch ? { fetch: o.fetch, registryFetch: o.fetch } : {}), ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.now ? { now: o.now } : {}) }) };
    }
    return made;
  };
  const reads = (lib: ChantModuleTargets, t: ChantModuleTarget) => ({ env: o.env, redactor: lib.createRedactor(o.env, t.credentialEnv) });
  /** A host's refusal as a config error: its message and fix, masked. */
  const asConfig = (lib: ChantModuleTargets, e: unknown): unknown =>
    e instanceof lib.PublishTargetError ? new ConfigError(`${label}: ${e.message}${e.fix ? ` ${e.fix}` : ""}`) : e;
  const address = (mod: { name: string; rel: string }) => hostedAddress(o.registry, mod, namespace);
  const logs = new Map<string, string>();
  let ledger: ReturnType<typeof readModuleLedger> | undefined;

  return {
    label,
    async latest(mod) {
      const { lib, target: t } = await target();
      let listed: string[];
      try {
        listed = await t.versions(address(mod), reads(lib, t));
      } catch (e) {
        throw asConfig(lib, e);
      }
      const best = listed
        .map((v) => parseSemver(v))
        .filter((v): v is Semver => !!v)
        .sort(compareSemver)
        .at(-1);
      if (!best) return undefined;
      const v = formatSemver(best);
      // The version's release record: its commit, and the module's content there.
      const record = (await (ledger ??= readModuleLedger(o.repo))).records.find((r) => r.component === mod.rel && r.releaseVersion === v);
      if (record) {
        const tar = moduleTarAt(o.repo, record.gitSha, mod.rel);
        if (tar) return { version: best, revision: record.gitSha, content: sha256(tar) };
      }
      // No record (a version uploaded by hand, or before every publish was recorded): the archive the host serves, and the git tag's commit.
      let held: Awaited<ReturnType<ChantModuleTarget["held"]>>;
      try {
        held = await t.held(address(mod), v, reads(lib, t));
      } catch (e) {
        throw asConfig(lib, e);
      }
      const tag = o.gitTags ? tryGit(o.repo, ["rev-list", "-n", "1", `refs/tags/${mod.rel}/v${v}`]) : undefined;
      if (held?.content && tag) return { version: best, revision: tag, content: held.content };
      throw new ConfigError(
        `${label} holds ${source(address(mod))} ${v}, and the ledger has no release record of it${record ? ` whose commit ${record.gitSha.slice(0, 8)} this checkout holds` : ""}${o.gitTags ? ` and there is no tag ${mod.rel}/v${v}` : ""}, so publish cannot tell what changed since; fetch chant/lifecycle and the full history, or publish git-tags too so the tag names the commit`,
      );
    },
    async existing(mod, version) {
      const { lib, target: t } = await target();
      try {
        const held = await t.held(address(mod), formatSemver(version), reads(lib, t));
        return held ? { ref: `${source(address(mod))} ${formatSemver(version)}`, content: held.content } : undefined;
      } catch (e) {
        throw asConfig(lib, e);
      }
    },
    async publish(mod, version, ctx) {
      const { lib, target: t } = await target();
      const v = formatSemver(version);
      // The record goes first, as for an OCI tag, so no version is out without one.
      await ctx.pushWithRecord?.([]);
      const said: string[] = [];
      const redactor = lib.createRedactor(o.env, t.credentialEnv);
      const c: ChantModuleVersionContext = {
        cwd: o.repo,
        env: o.env,
        redactor,
        log: (line) => said.push(redactor.redact(line)),
        provenance: { oidc: false, ci: null, reason: "a module version carries terragucci's own attestation, not a registry's" },
        tag: null,
        address: address(mod),
        version: v,
        archive: gzip(ctx.tar),
        revision: ctx.revision,
        content: ctx.content,
      };
      try {
        await t.plan(c);
        const staged = await t.stage(c);
        await t.reveal(c, staged);
      } catch (e) {
        throw asConfig(lib, e);
      }
      if (said.length) logs.set(`${mod.rel}@${v}`, said.join("; "));
      return ctx.content;
    },
    subject(mod, version, ctx) {
      return { ref: `${source(address(mod))} ${formatSemver(version)}`, bytes: ctx.tar };
    },
    note: (mod, version) => logs.get(`${mod.rel}@${formatSemver(version)}`),
  };
}

/** `gitlab` (in GitLab CI) or `gitlab://<host>/<project path>`: where it uploads and the namespace its sources name. */
export function gitlabPlace(p: string, env: NodeJS.ProcessEnv): { api?: string; project: string; namespace: string; host: string } {
  if (p === "gitlab") {
    const project = env.CI_PROJECT_ID;
    const namespace = env.CI_PROJECT_ROOT_NAMESPACE ?? env.CI_PROJECT_PATH?.split("/")[0];
    const api = env.CI_API_V4_URL;
    if (!project || !namespace || !api) {
      throw new ConfigError("modules.publish: gitlab reads the project from GitLab CI (CI_PROJECT_ID, CI_PROJECT_ROOT_NAMESPACE, CI_API_V4_URL), and this is not a GitLab CI job; outside it, write gitlab://<host>/<project path>");
    }
    return { project, namespace, host: new URL(api).host.toLowerCase() };
  }
  const m = /^gitlab:\/\/([^/\s]+)\/([^\s?#]+?)\/*$/.exec(p);
  if (!m || !m[2].includes("/")) throw new ConfigError(`modules.publish is ${JSON.stringify(p)}; write gitlab://<host>/<group>/<project>, such as gitlab://gitlab.example.com/platform/modules`);
  const host = m[1].toLowerCase();
  return { api: `https://${host}/api/v4`, project: m[2], namespace: m[2].split("/")[0]!, host };
}

/** The GitLab module registry as a publish target. */
export function gitlabTarget(p: string, o: HostedOptions): HostedTarget {
  const place = gitlabPlace(p, o.env);
  return hostedTarget(
    p,
    (lib, deps) => lib.gitlabModuleTarget({ project: place.project, ...(place.api ? { api: place.api } : {}), namespace: place.namespace }, deps),
    place.namespace,
    (a) => `${place.host}/${a.namespace}/${a.name}/${a.system}`,
    o,
  );
}
