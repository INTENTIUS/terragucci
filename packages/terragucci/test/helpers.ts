import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

// Every dir tmp() made in this test file, removed once the file's tests are done.
// A browser a test started can still be writing its profile, so removal retries
// and never fails the file.
const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // left behind; the OS temp dir clears it
    }
  }
});

export function tmp(prefix = "terragucci-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Write files under `root`; keys are relative paths. */
export function write(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

export const backend = (key: string): string => `terraform {
  backend "s3" {
    bucket = "state"
    key    = "${key}"
    region = "us-east-1"
  }
}

provider "aws" {
  region = "us-east-1"
}
`;

export const remoteState = (key: string): string => `data "terraform_remote_state" "up" {
  backend = "s3"
  config = {
    bucket = "state"
    key    = "${key}"
    region = "us-east-1"
  }
}
`;

/** A small repo: a network root, an app root reading the network's state, and a module that is not a root. */
export function twoRootRepo(root = tmp()): string {
  return write(root, {
    "network/main.tf": backend("network.tfstate"),
    "app/main.tf": backend("app.tfstate") + remoteState("network.tfstate") + `module "svc" {\n  source = "../modules/svc"\n}\n`,
    "modules/svc/main.tf": `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n}\n`,
  });
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Commit everything in `dir` and push it to a new bare repo; returns the bare repo's path. */
export function bareFrom(dir: string): string {
  const bare = tmp("terragucci-bare-");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  git(dir, "push", "-q", bare, "main");
  return bare;
}

/** Enough of JSON Schema for this one: type, const, enum, required, properties, items, additionalProperties and local $ref. */
export function validate(schema: Json, value: unknown, at = "$", root: Json = schema): string[] {
  if (typeof schema.$ref === "string") return validate(root.$defs[(schema.$ref as string).split("/").pop()!], value, at, root);
  const errs: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types.length && !types.some((t: string) => t === typeOf(value) || (t === "number" && typeof value === "number"))) return [`${at}: ${typeOf(value)} is not ${types.join("|")}`];
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${at}: not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in (value as Json))) errs.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value as Json)) {
      const sub = schema.properties?.[k] ?? schema.additionalProperties;
      if (sub && typeof sub === "object") errs.push(...validate(sub, v, `${at}.${k}`, root));
      else if (schema.properties && !schema.additionalProperties) errs.push(`${at}: ${k} is not in the schema`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`, root)));
  return errs;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
