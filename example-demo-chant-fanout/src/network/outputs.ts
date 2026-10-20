/**
 * What the `network` stack publishes. These two names are the ones the cluster
 * components pass to `stackOutput("network", ...)`, so this file and
 * `clusters.component.ts` are the two halves of the same edge.
 */
import { output } from "@intentius/chant-lexicon-aws";
import { networkQueue, networkTopic } from "./resources";

export const networkTopicArn = output(networkTopic.TopicArn, "TopicArn");
export const networkQueueUrl = output(networkQueue.QueueUrl, "QueueUrl");
