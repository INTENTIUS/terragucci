/**
 * `app-08`: one CloudWatch log group and one SQS queue, sitting on
 * `cluster-b`.
 *
 * The log group's name is built from the upstream table's name, so the
 * parameter is read by the template rather than merely declared by it. That is
 * the whole reason this estate has real cross-stack wiring instead of a
 * dependency list: `app-08` cannot be synthesized into something deployable
 * without a value that only `cluster-b` produces.
 */
import { LogGroup, Queue, Ref, Sub } from "@intentius/chant-lexicon-aws";
import { app08TableName } from "./params";

const tags = [
  { Key: "chant:estate", Value: "fan-out-estate" },
  { Key: "chant:tier", Value: "app" },
  { Key: "chant:cluster", Value: "cluster-b" },
];

export const app08LogGroup = new LogGroup({
  LogGroupName: Sub`/chant/fan-out-estate/app-08/${Ref(app08TableName)}`,
  RetentionInDays: 14,
  Tags: tags,
});

// The queue carries the upstream table name as a tag, so the edge is
// readable on the deployed resource and not only in this repository.
const queueTags = [...tags, { Key: "chant:table", Value: Ref(app08TableName) }];

export const app08Queue = new Queue({
  QueueName: "fan-out-estate-app-08",
  SqsManagedSseEnabled: true,
  Tags: queueTags,
});
