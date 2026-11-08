/**
 * `terragucci relay`: the container's entrypoint for chant's relay
 * (`chant notify relay`, chant#4611, #4759), run in the customer's own cloud.
 * terragucci hosts nothing.
 *
 * A waiting wave's Slack message carries chant's Approve and Decline buttons,
 * and its Teams card the reply `@<relay> approve <reference>`, each signed
 * with the relay key (./notify.ts). chant's relay verifies the click, maps
 * the chat user to a principal through the signers file, and records the
 * approval as `chant approve tf-apply wave-<k>` does, relayed by the relay.
 * A gate that asks a decision point gets its question answered instead.
 *
 * chant does the host's setup too (`--repo`, `--token-env`, chant#4759): it
 * refuses a token that is more than approve-only (one that administers the
 * repo, may push to its default branch, or on GitLab carries the api scope),
 * clones the repo's default branch with the token as a git header for this
 * process only, and serves from that checkout. What stays here is
 * terragucci's names for the settings, mapped onto chant's flags and
 * variables, and the relay listening on every interface, as a container's
 * port is reached.
 */
import { RELAY_ENV as CHANT_RELAY_ENV, RELAY_REPO_ENV } from "@intentius/chant/notify-relay";
import { runChantInProcess } from "@intentius/chant/ci-product";
import { TERRAGUCCI_WORDS } from "./ci-words";
import { ConfigError } from "./config";

/** The host's settings, from its environment, beside chant's own (`CHANT_RELAY_KEY`, `SLACK_SIGNING_SECRET`, `TEAMS_WEBHOOK_SECRET`). */
export const RELAY_ENV = {
  /** The repo's https clone address; chant's `--repo`. */
  repo: "TERRAGUCCI_RELAY_REPO",
  /** The approve-only token; chant's `--token-env` names it. */
  token: "TERRAGUCCI_RELAY_TOKEN",
  /** github, gitlab or forgejo, for a host other than github.com and gitlab.com; chant's `--forge`. */
  forge: "TERRAGUCCI_RELAY_FORGE",
  /** The principal the relay records as `relayedBy`; chant's `CHANT_RELAY_PRINCIPAL`. */
  principal: "TERRAGUCCI_RELAY_PRINCIPAL",
  /** Comma-separated address prefixes a Slack response_url may have; chant's `CHANT_RELAY_SLACK_RESPONSE`. */
  slackResponse: "TERRAGUCCI_RELAY_SLACK_RESPONSE",
} as const;

/** chant's relay settings from terragucci's names, where chant's are not set. */
export function chantRelayEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const principal = env[CHANT_RELAY_ENV.principal]?.trim() || env[RELAY_ENV.principal]?.trim();
  if (principal && /[\r\n]/.test(principal)) throw new ConfigError(`${RELAY_ENV.principal} is one principal on one line`);
  const slackResponse = env[CHANT_RELAY_ENV.slackResponse] || env[RELAY_ENV.slackResponse];
  return { ...(principal ? { [CHANT_RELAY_ENV.principal]: principal } : {}), ...(slackResponse ? { [CHANT_RELAY_ENV.slackResponse]: slackResponse } : {}) };
}

/** `chant notify relay` with terragucci's settings: the repo to clone, the variable holding the token, the forge, and every interface on `port`. */
export function relayArgv(env: NodeJS.ProcessEnv, port: number): string[] {
  const repo = env[RELAY_ENV.repo]?.trim() || env[RELAY_REPO_ENV.repo]?.trim();
  if (!repo) throw new ConfigError(`${RELAY_ENV.repo} is empty: it holds the repo's https clone address, such as https://github.com/acme/infra.git`);
  const forge = env[RELAY_ENV.forge]?.trim() || env[RELAY_REPO_ENV.forge]?.trim();
  const tokenEnv = env[RELAY_ENV.token] !== undefined || env[RELAY_REPO_ENV.token] === undefined ? RELAY_ENV.token : RELAY_REPO_ENV.token;
  return ["notify", "relay", "--repo", repo, "--token-env", tokenEnv, ...(forge ? ["--forge", forge] : []), "--host", env[CHANT_RELAY_ENV.host] || "0.0.0.0", "--port", String(port)];
}

/** Serve chant's relay on `port` from a checkout chant clones. Runs until the process is stopped. */
export async function startRelay(o: { port: number; env?: NodeJS.ProcessEnv }): Promise<number> {
  const env = o.env ?? process.env;
  const argv = relayArgv(env, o.port);
  Object.assign(process.env, chantRelayEnv(env));
  return runChantInProcess(argv, TERRAGUCCI_WORDS);
}
