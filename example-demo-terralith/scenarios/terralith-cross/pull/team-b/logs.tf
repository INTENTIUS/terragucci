# team-b's log group, its retention read from the shared root's estate.

resource "aws_cloudwatch_log_group" "team_b" {
  name              = "tl-team-b-logs"
  retention_in_days = data.terraform_estate_outputs.platform.values.log_retention_days
}

data "terraform_estate_outputs" "platform" {
  estate = "tl-shared"
  names  = ["log_retention_days"]
}
