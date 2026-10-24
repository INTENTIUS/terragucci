/**
 * app: a security group in the VPC, a network interface in subnet a, and the
 * port the app listens on, which is the port network's proxy forwards.
 */
import { NetworkInterface, Ref, SecurityGroup, SsmParameter } from "@intentius/chant-lexicon-aws";
import { appAdminPort, appHttpProxyPort, appSubnetAId, appVpcId } from "./params";

const tags = [
  { Key: "chant:estate", Value: "chant-compose" },
  { Key: "chant:tier", Value: "app" },
];

export const webSecurityGroup = new SecurityGroup({
  GroupDescription: "chant-compose web",
  VpcId: Ref(appVpcId),
  Tags: tags,
});

export const webInterface = new NetworkInterface({
  SubnetId: Ref(appSubnetAId),
  Tags: tags,
});

export const listenerPort = new SsmParameter({
  Name: "/chant-compose/listener-port",
  Type: "String",
  Value: Ref(appHttpProxyPort),
});

export const adminListenerPort = new SsmParameter({
  Name: "/chant-compose/admin-listener-port",
  Type: "String",
  Value: Ref(appAdminPort),
});
