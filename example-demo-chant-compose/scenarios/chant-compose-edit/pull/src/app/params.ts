/**
 * network's outputs, declared as CloudFormation parameters of the `app` stack.
 *
 * A parameter is how the edge becomes a fact of the source rather than a line
 * in a registry. `app` cannot deploy without values for these, and the only
 * thing that produces them is `network`. app.component.ts fills them with
 * `stackOutput("network", ...)`, and the CloudFormation parameter name is this
 * export's name.
 */
import { Parameter } from "@intentius/chant-lexicon-aws";

export const appVpcId = new Parameter("String", {
  description: "The network stack's VpcId output",
});

export const appSubnetAId = new Parameter("String", {
  description: "The network stack's SubnetAId output",
});

export const appHttpProxyPort = new Parameter("String", {
  description: "The network stack's HttpProxyPort output",
});

export const appAdminPort = new Parameter("String", {
  description: "The network stack's AdminPort output",
});
