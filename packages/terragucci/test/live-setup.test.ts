import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BucketReport, BucketTarget } from "@intentius/chant/bucket-check";
import {
  bucketLines,
  checkStoreBucket,
  forgetLiveSetups,
  knownLiveSetup,
  parseLiveSetup,
  rememberLiveSetup,
  resolvedEstate,
  setupLine,
} from "@intentius/chant-lexicon-terraform/live-roots";
import { describeInit, init } from "../src/init";
import { codeRules } from "../src/tips/index";
import type { PolicyExec } from "../src/report/policy";
import { backendAttrs, readLiveSetup, resolvedRecordStore } from "../src/live-setup";
import { tmp, write } from "./helpers";

/** choudoufu#2293's `live-check -json` for a root whose s3 backend block the live block ignores. */
const DERIVED = {
  dir: "envs/prod/network",
  estate: "prod-network",
  estate_source: "backend_key",
  record_store: { kind: "s3", bucket: "acme-tfstate", prefix: "tofu-records/prod-network/", source: "backend", declared_at: "backend.tf:2" },
  blocked: false,
  instances: [],
};

/** A choudoufu before #2293: `estate` only when the live block names it, and no `estate_source` or `record_store`. */
const OLDER = { dir: "envs/prod/network", blocked: false, instances: [] };

const LIVE_ROOT = {
  "net/main.tf": 'terraform {\n  live {}\n  backend "s3" {\n    bucket = "acme-tfstate"\n    key    = "prod/network/terraform.tfstate"\n    region = "eu-west-1"\n  }\n}\n',
};

afterEach(() => forgetLiveSetups());

describe("the readers fall back to the live block", () => {
  it("read choudoufu's answer once it is remembered", () => {
    const repo = tmp();
    write(repo, LIVE_ROOT);
    const dir = join(repo, "net");
    // The live block names no estate and no record_store: the text alone gives none, and the local default.
    expect(resolvedEstate(dir)).toBeUndefined();
    rememberLiveSetup(dir, parseLiveSetup(JSON.stringify(DERIVED))!);
    expect(resolvedEstate(dir)).toBe("prod-network");
    // The JSON has no region; the backend block's is used.
    expect(resolvedRecordStore(dir, "prod-network")).toEqual({ kind: "s3", bucket: "acme-tfstate", prefix: "tofu-records/prod-network/", region: "eu-west-1" });
  });

  it("read the live block when choudoufu printed nothing", () => {
    const repo = tmp();
    write(repo, { "net/main.tf": 'terraform {\n  live {\n    estate = "e"\n  }\n}\n' });
    const dir = join(repo, "net");
    expect(resolvedEstate(dir)).toBe("e");
    expect(resolvedRecordStore(dir, "e")).toEqual({ kind: "local", dir: join(dir, ".tofu-records"), prefix: "tofu-records/e/" });
  });
});

describe("readLiveSetup", () => {
  it("runs live-check -json once per root and remembers the answer", async () => {
    const repo = tmp();
    write(repo, LIVE_ROOT);
    const calls: string[][] = [];
    const exec: PolicyExec = async (_file, args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify(DERIVED), stderr: "" };
    };
    const dir = join(repo, "net");
    expect((await readLiveSetup(dir, { exec }))?.estate).toBe("prod-network");
    expect((await readLiveSetup(dir, { exec }))?.estate).toBe("prod-network");
    expect(calls).toEqual([["live-check", "-json", dir]]);
    expect(knownLiveSetup(dir)?.store?.bucket).toBe("acme-tfstate");
  });

  it("gives nothing on an older choudoufu, and remembers nothing", async () => {
    const repo = tmp();
    write(repo, LIVE_ROOT);
    const exec: PolicyExec = async () => ({ status: 0, stdout: JSON.stringify(OLDER), stderr: "" });
    expect(await readLiveSetup(join(repo, "net"), { exec })).toBeUndefined();
    expect(knownLiveSetup(join(repo, "net"))).toBeUndefined();
  });
});

describe("the bucket check", () => {
  it("gives chant's check the region from the root's backend block, and prints each failing setting with its fix", async () => {
    const seen: unknown[] = [];
    const check = async (target: BucketTarget, options: { namespaces: string[] }): Promise<BucketReport> => {
      seen.push(target, options);
      return {
        store: "s3",
        bucket: "acme-tfstate",
        namespaces: ["tofu-records/prod-network/"],
        correct: false,
        settings: [
          { setting: "versioning", verdict: "fail", found: "versioning is Suspended", unwaivable: false, fix: "aws s3api put-bucket-versioning --bucket acme-tfstate --versioning-configuration Status=Enabled" },
          { setting: "lifecycle", verdict: "ok", found: "a rule expires noncurrent versions after 30 days", unwaivable: false },
          { setting: "public_access_block", verdict: "unreadable", found: "GetPublicAccessBlock was denied", unwaivable: false },
        ],
      } as unknown as BucketReport;
    };
    const repo = tmp();
    write(repo, LIVE_ROOT);
    const store = parseLiveSetup(JSON.stringify(DERIVED))!.store!;
    const outcome = await checkStoreBucket(store, backendAttrs(join(repo, "net")), {}, check);
    expect(seen).toEqual([{ store: "s3", bucket: "acme-tfstate", region: "eu-west-1" }, { namespaces: ["tofu-records/prod-network/"] }]);
    expect(bucketLines("net", outcome)).toEqual([
      "net: bucket acme-tfstate: versioning fails: versioning is Suspended; fix: aws s3api put-bucket-versioning --bucket acme-tfstate --versioning-configuration Status=Enabled",
      "net: bucket acme-tfstate: public_access_block could not be read: GetPublicAccessBlock was denied",
    ]);
  });
});

describe("init under choudoufu", () => {
  it("prints the store choudoufu derives and writes no record_store of its own", async () => {
    const repo = tmp();
    write(repo, LIVE_ROOT);
    const exec: PolicyExec = async () => ({ status: 0, stdout: JSON.stringify(DERIVED), stderr: "" });
    const r = await init(repo, { binary: "choudoufu", forge: "github", dryRun: true, bucketCheck: false, liveExec: exec });
    expect(r.records).toEqual([{ root: "net", from: "choudoufu", line: setupLine("net", parseLiveSetup(JSON.stringify(DERIVED))!), bucket: [] }]);
    expect(describeInit(repo, r, true)).toContain('records: net: records in s3 bucket "acme-tfstate"');
    expect(r.files.some((f) => /record_store/.test(f.content))).toBe(false);
  });

  it("reads the live block on a choudoufu that prints no store", async () => {
    const repo = tmp();
    write(repo, { "net/main.tf": 'terraform {\n  live {\n    estate = "net"\n  }\n}\n' });
    const exec: PolicyExec = async () => ({ status: 0, stdout: JSON.stringify(OLDER), stderr: "" });
    const r = await init(repo, { binary: "choudoufu", forge: "github", dryRun: true, liveExec: exec });
    expect(r.records.map((x) => x.from)).toEqual(["live block"]);
    expect(r.records[0]!.line).toContain('estate "net"');
  });

  it("runs no live-check for tofu", async () => {
    const repo = tmp();
    write(repo, { "net/main.tf": 'terraform {\n  backend "s3" {}\n}\n' });
    const exec: PolicyExec = async () => {
      throw new Error("live-check ran");
    };
    const r = await init(repo, { binary: "tofu", forge: "github", dryRun: true, liveExec: exec });
    expect(r.records).toEqual([]);
  });
});

describe("TF046 in the tips", () => {
  it("is on", async () => {
    expect(Object.keys(await codeRules({}))).toContain("TF046");
  });

});
