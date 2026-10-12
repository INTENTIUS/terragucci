/**
 * The credentials a re-plan's trade step left for the plan step: the file
 * TRADED_ENV names, which ./oidc-trade.ts writes. rootRoleEnv, the report's
 * stores and the Terragrunt auth provider read it instead of an OIDC token,
 * which a re-plan's plan step never holds.
 */
import { readFileSync } from "node:fs";
import { StoreError } from "./report/object-store";

/** The variable that names the traded credentials' file. */
export const TRADED_ENV = "TERRAGUCCI_TRADED";

export interface TradedAws {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: string;
}

export interface Traded {
  /** Session keys by role ARN. */
  aws: Record<string, TradedAws>;
  /** Access tokens by service account. */
  gcp: Record<string, { token: string; expires: number }>;
}

/** The traded credentials TRADED_ENV names; undefined when the job traded none. */
export function tradedFromEnv(env: NodeJS.ProcessEnv): Traded | undefined {
  const file = env[TRADED_ENV];
  if (!file) return undefined;
  try {
    const t = JSON.parse(readFileSync(file, "utf-8")) as Partial<Traded>;
    return { aws: t.aws ?? {}, gcp: t.gcp ?? {} };
  } catch (e) {
    throw new StoreError(`${TRADED_ENV} names ${file}, which cannot be read: ${(e as Error).message}`);
  }
}

/** One role's traded keys, or a refusal naming it. */
export function tradedRole(traded: Traded, role: string): TradedAws {
  const c = traded.aws[role];
  if (!c) throw new StoreError(`the re-plan traded no credentials for ${role}`);
  return c;
}
