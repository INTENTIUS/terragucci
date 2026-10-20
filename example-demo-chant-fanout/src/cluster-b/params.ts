/**
 * The `network` stack's outputs, declared as CloudFormation parameters of the
 * `cluster-b` stack.
 *
 * A parameter is how the edge becomes a fact of the source rather than a line
 * in a registry. `cluster-b` cannot deploy without values for these two, and
 * the only thing that produces them is `network`. The component file fills them
 * with `stackOutput("network", "TopicArn" | "QueueUrl")`, and the CloudFormation
 * parameter name is this export's name.
 */
import { Parameter } from "@intentius/chant-lexicon-aws";

export const clusterBTopicArn = new Parameter("String", {
  description: "The network stack's TopicArn output",
});

export const clusterBQueueUrl = new Parameter("String", {
  description: "The network stack's QueueUrl output",
});
