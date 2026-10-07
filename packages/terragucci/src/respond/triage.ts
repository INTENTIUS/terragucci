/**
 * Apply-failed triage: each error in an apply's log is matched against a
 * table of known provider errors, and a known one comes back with its likely
 * fix. An error the table does not know is listed as such, for a person.
 */

export type ErrorClass = "access-denied" | "quota" | "throttling" | "already-exists" | "dependency" | "state-lock";

export interface KnownError {
  id: string;
  class: ErrorClass;
  match: RegExp;
  fix: string;
}

const EXISTS = "The resource exists already, outside this state. Import it with an import block (its address and id) or give it another name, then plan again.";

// First match wins, so the narrow entries come before the broad ones.
export const KNOWN_ERRORS: KnownError[] = [
  {
    id: "state-lock",
    class: "state-lock",
    match: /Error acquiring the state lock/,
    fix: "Another run holds the state lock. Wait for it to finish; when no run is going, a person removes the lock with `force-unlock` and the lock ID from the log.",
  },
  {
    id: "access-denied",
    class: "access-denied",
    match: /\b(AccessDenied(Exception)?|UnauthorizedOperation|AuthorizationError|not authorized to perform)\b/,
    fix: "The apply role lacks a permission. Grant it to the apply role, or check the job assumed the apply role and not the read-only plan role.",
  },
  {
    id: "throttling",
    class: "throttling",
    match: /\b(Throttling(Exception)?|RequestLimitExceeded|TooManyRequestsException|SlowDown|Rate exceeded)\b/,
    fix: "The cloud API throttled the run. Run the apply again; if it keeps happening, lower `-parallelism` or raise the provider's `max_retries`.",
  },
  {
    id: "quota",
    class: "quota",
    match: /\b(\w*LimitExceeded(Exception)?|ServiceQuotaExceededException|TooManyBuckets|Cannot exceed quota)\b/,
    fix: "An account quota is reached. Raise it in Service Quotas or remove resources nobody uses, then run the apply again.",
  },
  {
    id: "bucket-name-taken",
    class: "already-exists",
    match: /\bBucketAlreadyExists\b/,
    fix: "S3 bucket names are global and another account holds this one. Give the bucket another name.",
  },
  {
    id: "already-exists",
    class: "already-exists",
    match: /\b(EntityAlreadyExists|ResourceAlreadyExistsException|AlreadyExistsException|BucketAlreadyOwnedByYou|QueueAlreadyExists|QueueNameExists|InvalidGroup\.Duplicate|InvalidKeyPair\.Duplicate|ResourceInUseException: Table already exists|already exists - to be managed via Terraform)\b/,
    fix: EXISTS,
  },
  {
    id: "bucket-not-empty",
    class: "dependency",
    match: /\bBucketNotEmpty\b/,
    fix: "The bucket still holds objects. Empty it, or set `force_destroy = true` and apply that first, if losing the objects is intended.",
  },
  {
    id: "dependency",
    class: "dependency",
    match: /\b(DependencyViolation|DeleteConflict|has a dependent object|has dependencies and cannot be deleted)\b/,
    fix: "Something still uses the resource. Remove or move what depends on it first (often a resource in another root, or one made outside Terraform), then apply again.",
  },
];

export interface Diagnostic {
  /** The resource the error is about, from the diagnostic's `with` line. */
  address?: string;
  /** The first line of the error. */
  summary: string;
  /** The provider's error code, such as `AccessDenied`, when the message carries one. */
  code?: string;
  text: string;
}

export interface Triaged extends Diagnostic {
  id: string;
  class: ErrorClass;
  fix: string;
  /** The permission a denied call needed, when the message names it. */
  action?: string;
}

export interface Triage {
  known: Triaged[];
  unknown: Diagnostic[];
}

// Colour codes, and the box Terraform and OpenTofu draw around a diagnostic.
const clean = (log: string): string => log.replace(/\x1b\[[0-9;]*m/g, "").replace(/^[ \t]*[│╷╵][ \t]?/gm, "");

/** The errors in an apply's log, one per `Error:` diagnostic. */
export function diagnostics(log: string): Diagnostic[] {
  const parts = clean(log).split(/^Error: /m).slice(1);
  return parts.map((part) => {
    const text = part.replace(/\n(?:Warning: |Releasing state lock|Apply complete|\S+: (?:Creating|Destroying|Modifying)\.\.\.)[\s\S]*$/, "").trim();
    const address = /^\s*with ([^,\n]+),/m.exec(text)?.[1];
    const code = (/api error ([A-Z][\w.]+):/.exec(text) ?? /RequestID: [^,]+, (?:HostID: [^,]+, )?(?!HostID)([A-Z][\w.]+):/.exec(text))?.[1];
    return { summary: text.split("\n", 1)[0]!, text, ...(address ? { address } : {}), ...(code ? { code } : {}) };
  });
}

export function triage(log: string): Triage {
  const out: Triage = { known: [], unknown: [] };
  for (const d of diagnostics(log)) {
    const hit = KNOWN_ERRORS.find((k) => k.match.test(d.text));
    if (!hit) {
      out.unknown.push(d);
      continue;
    }
    const action = /not authorized to perform:? ([\w-]+:[\w*]+)/.exec(d.text)?.[1];
    out.known.push({ ...d, id: hit.id, class: hit.class, fix: hit.fix, ...(action ? { action } : {}) });
  }
  return out;
}

export function describeTriage(t: Triage): string {
  if (t.known.length + t.unknown.length === 0) return "No errors found in the log.";
  const lines: string[] = [];
  for (const k of t.known) {
    lines.push(`- ${k.address ? `\`${k.address}\`: ` : ""}${k.class}${k.code ? ` (${k.code})` : ""}. ${k.fix}${k.action ? ` The call needed \`${k.action}\`.` : ""}`);
  }
  for (const u of t.unknown) {
    lines.push(`- ${u.address ? `\`${u.address}\`: ` : ""}not a known error: ${u.summary}`);
  }
  return lines.join("\n");
}
