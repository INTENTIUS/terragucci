# team-c's log group, moved from the terralith's logs.tf.

resource "aws_cloudwatch_log_group" "team_c" {
  name              = "tl-team-c-logs"
  retention_in_days = 7
}
