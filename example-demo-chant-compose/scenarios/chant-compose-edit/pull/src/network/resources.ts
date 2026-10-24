/**
 * The estate's network: a VPC, one subnet in it, and the port the proxy
 * listens on, kept as an SSM parameter. app reads the VPC and the subnet's ids
 * and the port; nothing here reads another stack.
 */
import { Ref, SsmParameter, Subnet, Vpc } from "@intentius/chant-lexicon-aws";

const tags = [
  { Key: "chant:estate", Value: "chant-compose" },
  { Key: "chant:tier", Value: "network" },
];

export const mainVpc = new Vpc({
  CidrBlock: "10.0.0.0/16",
  Tags: tags,
});

export const subnetA = new Subnet({
  VpcId: Ref(mainVpc),
  CidrBlock: "10.0.1.0/24",
  Tags: tags,
});

// The port is a value of the source, so the parameter and the output that publishes it read the same constant.
export const HTTP_PROXY_PORT = "8090";

export const httpProxyPort = new SsmParameter({
  Name: "/chant-compose/http-proxy-port",
  Type: "String",
  Value: HTTP_PROXY_PORT,
});

export const ADMIN_PORT = "9000";

export const adminPort = new SsmParameter({
  Name: "/chant-compose/admin-port",
  Type: "String",
  Value: ADMIN_PORT,
});
