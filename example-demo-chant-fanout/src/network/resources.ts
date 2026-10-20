/**
 * The root of the estate: one SNS topic and one SQS queue, in the `network`
 * stack. Everything else in this project is downstream of these two.
 *
 * Export names carry the stack's own name so they stay unique across the whole
 * estate, not just within this directory. `chant lint src` lints every stack
 * directory in one pass, so a name reused in two stacks would collide there.
 */
import { Queue, Topic } from "@intentius/chant-lexicon-aws";

const tags = [
  { Key: "chant:estate", Value: "fan-out-estate" },
  { Key: "chant:tier", Value: "network" },
];

export const networkTopic = new Topic({
  TopicName: "fan-out-estate-network",
  DisplayName: "fan-out-estate network",
  // The AWS-managed SNS key. WAW025 refuses an unencrypted topic, and the
  // emulator provisions this the same way it provisions a bare one.
  KmsMasterKeyId: "alias/aws/sns",
  Tags: tags,
});

export const networkQueue = new Queue({
  QueueName: "fan-out-estate-network",
  // SQS-managed server-side encryption (WAW026).
  SqsManagedSseEnabled: true,
  Tags: tags,
});
