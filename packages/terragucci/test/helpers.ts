import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function tmp(prefix = "terragucci-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
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
