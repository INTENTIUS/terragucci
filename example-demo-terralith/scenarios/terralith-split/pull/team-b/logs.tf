# team-b's log group, moved from the shared root's logs.tf.

resource "aws_cloudwatch_log_group" "team_b" {
  name              = "tl-team-b-logs"
  retention_in_days = 7
}
