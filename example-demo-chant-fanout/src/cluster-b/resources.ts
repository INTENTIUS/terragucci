/**
 * `cluster-b`: a DynamoDB table and a CloudWatch log group.
 *
 * The table carries the two upstream endpoints as tags, so the wiring is
 * readable on the deployed resource and not only in this repository. It is also
 * what makes the parameters load-bearing: drop the tags and the parameters go
 * unread, and an unread parameter is a declaration nobody has to keep true.
 */
import { DynamoDBTable, LogGroup, Ref } from "@intentius/chant-lexicon-aws";
import { clusterBQueueUrl, clusterBTopicArn } from "./params";

const tags = [
  { Key: "chant:estate", Value: "fan-out-estate" },
  { Key: "chant:tier", Value: "cluster" },
];

export const clusterBTable = DynamoDBTable({
  tableName: "fan-out-estate-cluster-b",
  partitionKey: { name: "id" },
  defaults: {
    table: {
      // WAW027 refuses a table with point-in-time recovery off.
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      Tags: [
        ...tags,
        { Key: "chant:upstream-topic", Value: Ref(clusterBTopicArn) },
        { Key: "chant:upstream-queue", Value: Ref(clusterBQueueUrl) },
      ],
    },
  },
});

export const clusterBLogGroup = new LogGroup({
  LogGroupName: "/chant/fan-out-estate/cluster-b",
  // WAW055 refuses a log group with no retention.
  RetentionInDays: 14,
  Tags: tags,
});
