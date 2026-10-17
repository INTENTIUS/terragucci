# team-a's log group, moved from the terralith's logs.tf.

resource "aws_cloudwatch_log_group" "team_a" {
  name              = "tl-team-a-logs"
  retention_in_days = 7
}
