# team-a's log group, its retention read from the terralith's estate.

resource "aws_cloudwatch_log_group" "team_a" {
  name              = "tl-team-a-logs"
  retention_in_days = data.terraform_estate_outputs.platform.values.log_retention_days
}

data "terraform_estate_outputs" "platform" {
  estate = "tl-terralith"
  names  = ["log_retention_days"]
}
