/**
 * `terragucci registry edge`: the files a user deploys in front of a
 * bucket-hosted module registry, from `modules.registry` (terragucci#1287,
 * chant#4566). The function is chant's terraform lexicon edge function
 * (`@intentius/chant-lexicon-terraform/registry/edge`), bundled by
 * scripts/build-cli.mjs into dist beside the CLI:
 *
 *   registry-edge-worker.mjs   a Cloudflare Worker (`export default registryWorker`)
 *   registry-edge-lambda.mjs   a Lambda@Edge origin-request handler that reads registry-edge.json beside it
 *
 * A terragucci built on a chant without the edge function has neither file,
 * and the command says so; publish and the registry files work as before.
 *
 * The function adds X-Terraform-Get to every download answer, so Terraform
 * installs. With `auth: token` it also refuses a read without one of its
 * bearer tokens and signs tarball URLs. This file holds only the words and
 * the deploy files around it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, registryEdge, type RegistryEdge, type RegistrySettings } from "../config";
import { parseReportsBucket } from "../report/object-store";

export const WORKER_BUNDLE = "registry-edge-worker.mjs";
export const LAMBDA_BUNDLE = "registry-edge-lambda.mjs";
/** The options file the Lambda@Edge bundle reads at start: Lambda@Edge has no environment variables. */
export const LAMBDA_OPTIONS = "registry-edge.json";
/** The tokens the Lambda@Edge options carry with `auth: token`, read when the command runs. */
export const TOKENS_VARIABLE = "TERRAGUCCI_REGISTRY_TOKENS";

export interface EdgeFile {
  path: string;
  content: string | Buffer;
}

export interface EdgePlan {
  edge: RegistryEdge;
  auth: boolean;
  files: EdgeFile[];
  /** The steps after the files are written, one per line. */
  steps: string[];
}

export interface EdgeOptions {
  /** Where the bundles are; default the directory of this module, which is dist/ in the bundled CLI. */
  bundleDir?: string;
  /** The bucket's HTTP address the function reads files from, in place of the one derived from `bucket`. */
  origin?: string;
  env?: NodeJS.ProcessEnv;
}

const here = (): string => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
};

/** The bucket's HTTP address, which the function reads `download` answers (and, without an R2 binding, every file) from. */
export function bucketOrigin(reg: Pick<RegistrySettings, "bucket" | "endpoint">): string | undefined {
  if (!reg.bucket) return undefined;
  const b = parseReportsBucket(reg.bucket);
  if (b.kind === "gcs") return `https://storage.googleapis.com/${b.bucket}`;
  if (b.kind === "azure") return `https://${b.account}.blob.core.windows.net/${b.container}`;
  if (reg.endpoint) return `${reg.endpoint.replace(/\/+$/, "")}/${b.bucket}`;
  return `https://${b.bucket}.s3.amazonaws.com`;
}

/** An R2 bucket's name, when the registry's bucket is on R2 and a Worker can bind it. */
function r2Bucket(reg: Pick<RegistrySettings, "bucket" | "endpoint">): string | undefined {
  if (!reg.bucket || !reg.endpoint || !/r2\.cloudflarestorage\.com/i.test(reg.endpoint)) return undefined;
  const b = parseReportsBucket(reg.bucket);
  return b.kind === "s3" ? b.bucket : undefined;
}

const toml = (v: string): string => JSON.stringify(v);

/** The tokens a value holds: one per line or comma separated, as the edge function reads its secret. */
export const tokensOf = (text: string | undefined): string[] => (text ?? "").split(/[\n,]/).map((t) => t.trim()).filter((t) => !!t);

function bundle(dir: string, name: string): Buffer {
  const file = join(dir, name);
  if (!existsSync(file)) {
    throw new ConfigError(`this terragucci carries no registry edge function (${name} is not beside it): it was built on a chant whose terraform lexicon has no registry/edge`);
  }
  return readFileSync(file);
}

/** The files and steps for the registry's edge preset. */
export function planEdge(reg: RegistrySettings, opts: EdgeOptions = {}): EdgePlan {
  const edge = registryEdge(reg);
  const auth = reg.auth === "token";
  const host = new URL(reg.url).host;
  const variable = `TF_TOKEN_${host.toLowerCase().replace(/-/g, "__").replace(/\./g, "_")}`;
  const dir = opts.bundleDir ?? here();
  if (edge === "pages") {
    return {
      edge,
      auth,
      files: [],
      steps: [
        `edge pages: publish writes _headers into ${reg.dir ?? "the registry's dir"} beside the registry's files, and Cloudflare Pages and Netlify send X-Terraform-Get from it; there is no function to deploy`,
        "GitHub Pages and GitLab Pages read no _headers file, so Terraform cannot install from them; OpenTofu can",
      ],
    };
  }
  if (edge === "none") {
    return { edge, auth, files: [], steps: ["edge none: the files are served as they are, which OpenTofu installs from and Terraform does not"] };
  }
  const origin = opts.origin ?? bucketOrigin(reg);
  if (edge === "cloudflare") {
    const r2 = opts.origin ? undefined : r2Bucket(reg);
    if (!r2 && !origin) throw new ConfigError("edge cloudflare reads the registry's files from an R2 binding or the bucket's address; give --origin <url>");
    const name = `${reg.namespace.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-module-registry`;
    const lines = [
      `name = ${toml(name)}`,
      `main = ${toml("worker.mjs")}`,
      `compatibility_date = ${toml("2026-10-01")}`,
      `routes = [{ pattern = ${toml(host)}, custom_domain = true }]`,
      "",
      "[vars]",
      `REGISTRY_AUTH = ${toml(auth ? "token" : "off")}`,
      ...(reg.prefix ? [`REGISTRY_PREFIX = ${toml(reg.prefix.replace(/^\/+|\/+$/g, ""))}`] : []),
      ...(r2 ? [] : [`REGISTRY_ORIGIN = ${toml(origin!)}`]),
      ...(r2 ? ["", "[[r2_buckets]]", `binding = ${toml("REGISTRY_BUCKET")}`, `bucket_name = ${toml(r2)}`] : []),
    ];
    return {
      edge,
      auth,
      files: [
        { path: "worker.mjs", content: bundle(dir, WORKER_BUNDLE) },
        { path: "wrangler.toml", content: `${lines.join("\n")}\n` },
      ],
      steps: [
        ...(auth
          ? [
              "make the token and keep a copy in your secret manager: openssl rand -hex 32",
              "store it as the Worker's secret: npx wrangler secret put REGISTRY_TOKENS (paste the token)",
            ]
          : []),
        `deploy: npx wrangler deploy, from the directory holding wrangler.toml; the Worker answers at ${host}`,
        ...(auth
          ? [
              `each reader sets ${variable} to the token, or a credentials "${host}" block in its CLI config`,
              "to rotate: put both tokens in REGISTRY_TOKENS (old,new), move every reader to the new one, then put the new one alone",
            ]
          : []),
        ...(r2 || auth ? [] : [`the Worker reads ${origin}, so that address must be readable from the Worker`]),
        ...(!r2 && auth ? [`the Worker reads ${origin}; keep the bucket closed to everyone else, or readers can skip the token check`] : []),
      ],
    };
  }
  // cloudfront
  if (!origin) throw new ConfigError("edge cloudfront reads each download answer from the bucket's address; give --origin <url>");
  const env = opts.env ?? process.env;
  const tokens = tokensOf(env[TOKENS_VARIABLE]);
  if (auth && tokens.length === 0) throw new ConfigError(`auth: token on CloudFront puts the tokens in the function, which has no environment of its own; set ${TOKENS_VARIABLE} to the token (two, comma separated, while one rotates out) and run this again`);
  const options = {
    origin,
    ...(reg.prefix ? { prefix: reg.prefix.replace(/^\/+|\/+$/g, "") } : {}),
    ...(auth ? { auth: { tokens } } : {}),
  };
  return {
    edge,
    auth,
    files: [
      { path: "index.mjs", content: bundle(dir, LAMBDA_BUNDLE) },
      { path: LAMBDA_OPTIONS, content: `${JSON.stringify(options, null, 2)}\n` },
    ],
    steps: [
      ...(auth ? [`${LAMBDA_OPTIONS} holds the tokens: keep the directory out of git`] : []),
      "zip index.mjs and registry-edge.json, and create a Lambda function from the zip in us-east-1 on Node.js 20 or later, handler index.handler",
      "publish a version and attach it to the distribution's default behavior as an origin-request trigger",
      "give that behavior an origin request policy that passes the Authorization header and every query string to the origin",
      `the function reads each download answer from ${origin}, so that address must be readable from the function`,
      ...(auth
        ? [
            `each reader sets ${variable} to the token, or a credentials "${host}" block in its CLI config`,
            `to rotate: run this again with both tokens in ${TOKENS_VARIABLE} (old,new), deploy that version, move every reader to the new token, then run it with the new one alone and deploy again`,
          ]
        : []),
    ],
  };
}

export function describeEdge(plan: EdgePlan, out: string): string {
  const head = plan.files.length ? `wrote ${out}: ${plan.files.map((f) => f.path).join(", ")} for edge ${plan.edge}, auth ${plan.auth ? "token" : "off"}` : `nothing to write for edge ${plan.edge}`;
  return [head, ...plan.steps.map((s) => `next: ${s}`)].join("\n");
}
