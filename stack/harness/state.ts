// Where the harness keeps its files. The stack writes forgejo.env and the demo
// reviewer's key into its own state directory, the one stack/instance.sh
// resolves from TG_STACK. A TG_STATE the caller sets (a worktree run puts it
// outside the checkout, where the driver wants scenario bases) holds the
// harness's own work: scenario bases, scratch, the claims ledger.
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** The stack's state directory, as stack/instance.sh names it for TG_STACK. */
export function stackStateDir(root: string, env: Env = process.env): string {
  const stack = env.TG_STACK || "shared";
  if (stack === "shared") return join(root, "stack", ".state");
  if (stack === "capture") return join(root, "stack", ".state-capture");
  throw new Error(`TG_STACK is '${stack}'; it is shared (the default) or capture`);
}

/** The harness's own state: the caller's TG_STATE, else the stack's directory. */
export function harnessStateDir(root: string, env: Env = process.env): string {
  return env.TG_STATE || stackStateDir(root, env);
}
