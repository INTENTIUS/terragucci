/**
 * `cluster-b`'s TableName output, declared as a CloudFormation parameter of
 * the `app-09` stack. The app component fills it with
 * `stackOutput("cluster-b", "TableName")`; the CloudFormation parameter name
 * is this export's name.
 */
import { Parameter } from "@intentius/chant-lexicon-aws";

export const app09TableName = new Parameter("String", {
  description: "The cluster-b stack's TableName output",
});
