# The shared root's team log groups, their retention from its own local.

resource "aws_cloudwatch_log_group" "team_a" {
  name              = "tl-team-a-logs"
  retention_in_days = local.log_retention_days
}

resource "aws_cloudwatch_log_group" "team_c" {
  name              = "tl-team-c-logs"
  retention_in_days = local.log_retention_days
}
