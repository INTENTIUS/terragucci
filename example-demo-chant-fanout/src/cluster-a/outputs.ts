/**
 * What `cluster-a` publishes to the six apps that sit on it. `TableName` is the
 * one they consume; `LogGroupName` is published because an operator reading the
 * stack wants it, and because a fan-out is more interesting when a stack has
 * more than one export to move.
 */
import { output, Ref } from "@intentius/chant-lexicon-aws";
import { clusterALogGroup, clusterATable } from "./resources";

// DynamoDB has no TableName attribute; Ref on the table is the table's name.
export const clusterATableName = output(Ref(clusterATable.table), "TableName");
export const clusterALogGroupName = output(Ref(clusterALogGroup), "LogGroupName");
