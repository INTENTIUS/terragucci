import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chantBucketCheck, chantTf046, overrideChantNext } from "../src/chant-next";
import { describeInit, init } from "../src/init";
import { liveImportReadsBackend } from "../src/migrate-estate";
import type { BinaryExec } from "../src/migrate";
import { codeRules, CODE_RULES } from "../src/tips/index";
import type { PolicyExec } from "../src/report/policy";
import {
  bucketLines,
  bucketTarget,
  checkStoreBucket,
  forgetLiveSetups,
  knownLiveSetup,
  parseLiveSetup,
  readLiveSetup,
  rememberLiveSetup,
  resolvedEstate,
  resolvedRecordStore,
  setupLine,
  type LiveSetup,
} from "../src/live-setup";
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

describe("parseLiveSetup", () => {
  it("reads the resolved estate and record store", () => {
    expect(parseLiveSetup(JSON.stringify(DERIVED))).toEqual({
      estate: "prod-network",
      estateSource: "backend_key",
      store: { kind: "s3", bucket: "acme-tfstate", prefix: "tofu-records/prod-network/", source: "backend", declaredAt: "backend.tf:2" },
    });
  });

  it("keeps the note on an implied local store", () => {
    const doc = { ...DERIVED, estate_source: "root_path", estate: "net", record_store: { kind: "local", bucket: ".tofu-records", prefix: "tofu-records/net/", source: "implied", note: 'backend "consul" has no record store counterpart' } };
    expect(parseLiveSetup(JSON.stringify(doc))?.store?.note).toBe('backend "consul" has no record store counterpart');
  });

  it("gives nothing for an older choudoufu, or output that is not JSON", () => {
    expect(parseLiveSetup(JSON.stringify(OLDER))).toBeUndefined();
    expect(parseLiveSetup("Error: no such command")).toBeUndefined();
  });
});

describe("setupLine", () => {
  it("names the store, where it came from, and the estate", () => {
    const setup = parseLiveSetup(JSON.stringify(DERIVED))!;
    expect(setupLine("net", setup)).toBe('net: records in s3 bucket "acme-tfstate" under tofu-records/prod-network/ (derived from its backend block at backend.tf:2); estate "prod-network" (from the backend key)');
  });

  it("names the local directory", () => {
    const setup: LiveSetup = { estate: "net", estateSource: "root_path", store: { kind: "local", bucket: ".tofu-records", prefix: "tofu-records/net/", source: "implied" } };
    expect(setupLine("net", setup)).toBe("net: records in the local directory .tofu-records under tofu-records/net/ (the local store, since no backend block gives one); estate \"net\" (from the root's path)");
  });
});

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
  it("builds chant's target from the store, the backend block and the job", () => {
    const repo = tmp();
    write(repo, LIVE_ROOT);
    const dir = join(repo, "net");
    const store = parseLiveSetup(JSON.stringify(DERIVED))!.store!;
    expect(bucketTarget(dir, store, {})).toEqual({ target: { store: "s3", bucket: "acme-tfstate", region: "eu-west-1" } });
    expect(bucketTarget(dir, store, { AWS_ENDPOINT_URL: "http://127.0.0.1:4566", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" })).toEqual({
      target: { store: "s3", bucket: "acme-tfstate", region: "eu-west-1", endpoint: "http://127.0.0.1:4566", credentials: { accessKeyId: "a", secretAccessKey: "b" } },
    });
    expect(bucketTarget(dir, { ...store, kind: "kubernetes", bucket: "ns" }, {})).toEqual({ skip: "a kubernetes store has no bucket to check" });
    expect("skip" in bucketTarget(dir, { ...store, kind: "azurerm", bucket: "acct/recs" }, {})).toBe(true);
  });

  it("is skipped on a chant without it", async () => {
    const restore = overrideChantNext("bucketCheck", null);
    try {
      const repo = tmp();
      write(repo, LIVE_ROOT);
      const store = parseLiveSetup(JSON.stringify(DERIVED))!.store!;
      expect(await checkStoreBucket(join(repo, "net"), store, {})).toEqual({ skipped: "the installed chant has no bucket check" });
    } finally {
      restore();
    }
  });

  it("passes the estate's prefix to chant's check and prints each failing setting with its fix", async () => {
    const seen: unknown[] = [];
    const restore = overrideChantNext("bucketCheck", {
      BucketCheckError: Error,
      checkBucket: async (target: unknown, options: unknown) => {
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
        };
      },
    });
    try {
      const repo = tmp();
      write(repo, LIVE_ROOT);
      const store = parseLiveSetup(JSON.stringify(DERIVED))!.store!;
      const outcome = await checkStoreBucket(join(repo, "net"), store, {});
      expect(seen[1]).toEqual({ namespaces: ["tofu-records/prod-network/"] });
      expect(bucketLines("net", outcome)).toEqual([
        "net: bucket acme-tfstate: versioning fails: versioning is Suspended; fix: aws s3api put-bucket-versioning --bucket acme-tfstate --versioning-configuration Status=Enabled",
        "net: bucket acme-tfstate: public_access_block could not be read: GetPublicAccessBlock was denied",
      ]);
    } finally {
      restore();
    }
  });

  it("is chant's own check where the installed chant carries it", async () => {
    const lib = await chantBucketCheck();
    if (!lib) return;
    expect(typeof lib.checkBucket).toBe("function");
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

describe("live-import reads the backend", () => {
  it("is told by live-import -help", async () => {
    const help = (out: string): BinaryExec => async () => ({ code: 0, stdout: out, out });
    expect(await liveImportReadsBackend(help("  -state=path   The tfstate file to read. Defaults to the state the backend block names.\n"), "choudoufu", ".", {})).toBe(true);
    expect(await liveImportReadsBackend(help("  -state=path   The tfstate file to read, once, read-only.\n"), "choudoufu", ".", {})).toBe(false);
  });
});

describe("TF046 in the tips", () => {
  it("is on where the installed chant has it, and absent where it does not", async () => {
    const lib = await chantTf046();
    const rules = await codeRules({});
    if (lib) expect(Object.keys(rules)).toContain("TF046");
    else expect(rules).toBe(CODE_RULES);
    const restore = overrideChantNext("tf046", null);
    try {
      expect(Object.keys(await codeRules({}))).not.toContain("TF046");
    } finally {
      restore();
    }
  });
});
