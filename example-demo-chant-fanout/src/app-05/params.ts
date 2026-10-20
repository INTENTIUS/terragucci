/**
 * `cluster-a`'s TableName output, declared as a CloudFormation parameter of
 * the `app-05` stack. The app component fills it with
 * `stackOutput("cluster-a", "TableName")`; the CloudFormation parameter name
 * is this export's name.
 */
import { Parameter } from "@intentius/chant-lexicon-aws";

export const app05TableName = new Parameter("String", {
  description: "The cluster-a stack's TableName output",
});
