# The pull request: one parameter in us-west-1, so a change reaches one
# region of the three (multi-region).
resource "aws_ssm_parameter" "pr" {
  provider = aws.usw1
  name     = "/multi-region/pr"
  type     = "String"
  value    = "one region of three"
}
