# Not generated: one log group per team, which terralith-gen's estate has
# none of. The split moves each to its team's root, and the cross-estate
# change sets each one's retention from the terralith's log_retention_days.

resource "aws_cloudwatch_log_group" "team_a" {
  name              = "tl-team-a-logs"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_b" {
  name              = "tl-team-b-logs"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "team_c" {
  name              = "tl-team-c-logs"
  retention_in_days = 7
}
