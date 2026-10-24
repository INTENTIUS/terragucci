/**
 * edge: the ranges it lets through, and the upstream it routes to, which is app
 * on the port app listens on.
 */
import { Sub, Ref, SsmParameter } from "@intentius/chant-lexicon-aws";
import { edgeListenerPort } from "./params";

export const allowlist = new SsmParameter({
  Name: "/chant-compose/allowlist",
  Type: "String",
  Value: "10.0.1.0/24",
});

export const upstream = new SsmParameter({
  Name: "/chant-compose/upstream",
  Type: "String",
  Value: Sub`http://app:${Ref(edgeListenerPort)}`,
});
