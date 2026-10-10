import { describe, expect, it } from "vitest";
import { addressWarnings, applyLayers, remoteStateReads, stateOf, unaddressedStates } from "../src/detect";
import { pgDatabase, stateAddress } from "../src/state-address";
import { tmp, write } from "./helpers";

/** A root whose backend block is `backend` with `attrs`. */
const owner = (backend: string, attrs: string): string => `terraform {\n  backend "${backend}" {\n${attrs}\n  }\n}\n`;
/** A root that reads a state of `backend` through terraform_remote_state "up". */
const reader = (backend: string, config: string, own = owner("local", "")): string => `${own}\ndata "terraform_remote_state" "up" {\n  backend = "${backend}"\n  config = {\n${config}\n  }\n}\n`;

/** net writes its state, app reads it: whether app is ordered after net. */
function edge(netCode: string, appCode: string): { layers: string[][]; reads: string[] } {
  const repo = write(tmp(), { "net/main.tf": netCode, "app/main.tf": appCode });
  return { layers: applyLayers(repo, ["net", "app"]), reads: (remoteStateReads(repo, ["net", "app"]).get("app") ?? []).map((r) => r.upstream) };
}

describe("a state address for every backend type", () => {
  const cases: { type: string; own: string; read: string; key: string }[] = [
    { type: "local", own: '    path = "../state/net.tfstate"', read: '    path = "../state/net.tfstate"', key: "local:state/net.tfstate" },
    { type: "pg", own: '    conn_str    = "postgres://tf:pw@db.internal:5432/states?sslmode=disable"\n    schema_name = "net"', read: '    conn_str    = "postgres://reader@DB.internal:5432/states"\n    schema_name = "net"', key: "pg:db.internal:5432/states/net.states" },
    { type: "http", own: '    address = "https://state.example.com/net"', read: '    address = "https://user:token@STATE.example.com/net/"', key: "http:https://state.example.com/net" },
    { type: "consul", own: '    address = "consul.internal:8500"\n    path    = "tf/net"', read: '    address = "http://consul.internal:8500"\n    path    = "tf/net"', key: "consul:consul.internal:8500/tf/net" },
    { type: "kubernetes", own: '    secret_suffix = "net"\n    namespace     = "infra"', read: '    secret_suffix = "net"\n    namespace     = "infra"', key: "kubernetes:infra/net" },
    { type: "remote", own: '    organization = "acme"\n    workspaces {\n      name = "net"\n    }', read: '    organization = "acme"\n    workspaces = {\n      name = "net"\n    }', key: "remote:app.terraform.io/acme/net" },
  ];
  for (const c of cases) {
    it(`${c.type}: the root that writes the state and the root that reads it line up`, () => {
      const repo = write(tmp(), { "net/main.tf": owner(c.type, c.own), "app/main.tf": reader(c.type, c.read) });
      expect(stateOf(repo, "net").own).toEqual({ key: c.key });
      expect(stateOf(repo, "app").reads).toEqual([{ name: "up", key: c.key, repeated: false }]);
      expect(applyLayers(repo, ["net", "app"])).toEqual([["net"], ["app"]]);
      expect(addressWarnings(repo, ["net", "app"])).toEqual([]);
    });
  }

  it("a cloud block lines up with a remote read of its workspace", () => {
    const net = 'terraform {\n  cloud {\n    hostname     = "tfe.example.com"\n    organization = "acme"\n    workspaces {\n      name = "net"\n    }\n  }\n}\n';
    expect(edge(net, reader("remote", '    hostname     = "tfe.example.com"\n    organization = "acme"\n    workspaces = { name = "net" }')).reads).toEqual(["net"]);
  });

  it("a different address is no edge", () => {
    expect(edge(owner("pg", '    conn_str = "postgres://db/states"\n    schema_name = "net"'), reader("pg", '    conn_str = "postgres://db/states"\n    schema_name = "other"')).layers).toEqual([["net", "app"]]);
    expect(edge(owner("http", '    address = "https://a.example.com/net"'), reader("http", '    address = "https://b.example.com/net"')).reads).toEqual([]);
    // Same path, another type: no two types share a key.
    expect(edge(owner("consul", '    address = "c:8500"\n    path = "net"'), reader("local", '    path = "net"')).reads).toEqual([]);
  });

  it("local: a path is the root's, so two roots name one file by different relative paths", () => {
    const repo = write(tmp(), { "envs/net/main.tf": owner("local", '    path = "net.tfstate"'), "envs/app/main.tf": reader("local", '    path = "../net/net.tfstate"') });
    expect(stateOf(repo, "envs/net").own).toEqual({ key: "local:envs/net/net.tfstate" });
    expect(applyLayers(repo, ["envs/net", "envs/app"])).toEqual([["envs/net"], ["envs/app"]]);
  });

  it("local: a root with no backend keeps terraform.tfstate beside its code", () => {
    expect(edge("resource \"terraform_data\" \"x\" {}\n", reader("local", '    path = "../net/terraform.tfstate"')).reads).toEqual(["net"]);
  });

  it("Terraform's JSON syntax gets the same addresses", () => {
    const net = JSON.stringify({ terraform: { backend: { kubernetes: { secret_suffix: "net", namespace: "infra" } } } });
    const app = JSON.stringify({ data: { terraform_remote_state: { up: { backend: "kubernetes", config: { secret_suffix: "net", namespace: "infra" } } } } });
    const repo = write(tmp(), { "net/cdk.tf.json": net, "app/cdk.tf.json": app });
    expect(applyLayers(repo, ["net", "app"])).toEqual([["net"], ["app"]]);
    const local = write(tmp(), { "a/cdk.tf.json": JSON.stringify({ terraform: { backend: { local: { path: "terraform.a.tfstate" } } } }) });
    expect(stateOf(local, "a").own).toEqual({ key: "local:a/terraform.a.tfstate" });
  });

  it("s3, gcs and azurerm keep their bucket and key", () => {
    const repo = write(tmp(), { "net/main.tf": owner("s3", '    bucket = "b"\n    key    = "net.tfstate"'), "app/main.tf": reader("s3", '    bucket = "b"\n    key    = "net.tfstate"') });
    expect(stateOf(repo, "net").own).toEqual({ bucket: "b", key: "net.tfstate" });
    expect(stateOf(repo, "app").reads[0]).toMatchObject({ bucket: "b", key: "net.tfstate" });
    expect(stateOf(write(tmp(), { "g/main.tf": owner("gcs", '    bucket = "b"\n    prefix = "net"') }), "g").own).toEqual({ bucket: "b", key: "net" });
  });

  it("credentials never reach an address", () => {
    expect(pgDatabase("postgres://tf:hunter2@db:5432/states")).toBe("db:5432/states");
    expect(pgDatabase("host=db port=5432 dbname=states user=tf password=hunter2")).toBe("db:5432/states");
    expect(stateAddress("http", (n) => (n === "address" ? "https://u:hunter2@gitlab.com/api/v4/projects/1/terraform/state/net?token=hunter2" : undefined), "")).toEqual({ key: "http:https://gitlab.com/api/v4/projects/1/terraform/state/net" });
  });
});

describe("a state the code does not address", () => {
  it("a read whose address is an expression or from the environment is named, not dropped", () => {
    const app = `${reader("pg", '    conn_str = var.conn')}\ndata "terraform_remote_state" "env" {\n  backend = "http"\n  config = {}\n}\ndata "terraform_remote_state" "tpl" {\n  backend = "s3"\n  config = {\n    bucket = "b"\n    key    = "\${var.env}/net.tfstate"\n  }\n}\n`;
    const repo = write(tmp(), { "net/main.tf": owner("pg", ""), "app/main.tf": app });
    const s = stateOf(repo, "app");
    expect(s.reads).toEqual([]);
    expect(s.unresolved).toEqual([
      { name: "up", why: "its pg conn_str is an expression, not a plain string" },
      { name: "env", why: "its http backend names no address in the code (TF_HTTP_ADDRESS or a -backend-config file supplies it)" },
      { name: "tpl", why: "its s3 key is an expression, not a plain string" },
    ]);
    expect(stateOf(repo, "net").ownUnresolved).toBe("its pg backend names no conn_str in the code (PG_CONN_STR or a -backend-config file supplies it)");
    expect(unaddressedStates(repo, ["net", "app"])).toEqual([
      { root: "net", own: "its pg backend names no conn_str in the code (PG_CONN_STR or a -backend-config file supplies it)", reads: [] },
      { root: "app", reads: s.unresolved },
    ]);
    const warnings = addressWarnings(repo, ["net", "app"]);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toBe("state: net keeps its state where the code does not say (its pg backend names no conn_str in the code (PG_CONN_STR or a -backend-config file supplies it)), so a root that reads it through terraform_remote_state is not ordered after it");
    expect(warnings[1]).toContain('state: app reads state through terraform_remote_state "up" where the code does not say');
  });

  it("each backend names what it needs", () => {
    const none = (): undefined => undefined;
    expect(stateAddress("consul", (n) => (n === "path" ? "tf/net" : undefined), "r")).toEqual({ unresolved: "its consul backend names no address in the code (CONSUL_HTTP_ADDR or a -backend-config file supplies it)" });
    expect(stateAddress("kubernetes", (n) => (n === "secret_suffix" ? "net" : undefined), "r")).toEqual({ unresolved: "its kubernetes backend names no namespace in the code (KUBE_NAMESPACE or a -backend-config file supplies it)" });
    expect(stateAddress("cloud", none, "r")).toEqual({ unresolved: "its cloud backend names no organization in the code (TF_CLOUD_ORGANIZATION or a -backend-config file supplies it)" });
    expect(stateAddress("remote", (n) => (n === "organization" ? "acme" : undefined), "r")).toMatchObject({ unresolved: expect.stringContaining("tags, prefix or TF_WORKSPACE") });
    expect(stateAddress("s3", none, "r")).toEqual({ unresolved: "its s3 backend names no key in the code (a -backend-config file supplies it)" });
    expect(stateAddress("local", none, "r")).toEqual({ key: "local:r/terraform.tfstate" });
  });

  it("a root whose own state is unaddressed is named only when some root reads state", () => {
    const repo = write(tmp(), { "a/main.tf": owner("s3", ""), "b/main.tf": owner("s3", "") });
    expect(addressWarnings(repo, ["a", "b"])).toEqual([]);
  });
});
