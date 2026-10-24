/**
 * What the `network` stack publishes. These names are the ones app.component.ts
 * passes to its `stackOutput` inputs, so this file and that one are the two
 * halves of the same edge.
 */
import { output, Ref } from "@intentius/chant-lexicon-aws";
import { HTTP_PROXY_PORT, mainVpc, subnetA } from "./resources";

export const networkVpcId = output(Ref(mainVpc), "VpcId");
export const networkSubnetAId = output(Ref(subnetA), "SubnetAId");
export const networkProxyPort = output(HTTP_PROXY_PORT, "HttpProxyPort");
