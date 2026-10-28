# The pull request: a second log group in the example's estate, so live-check
# and live-plan have a change to read and the merge's live-apply a change to
# gate and apply (tg-compose-ci-pipelines).
resource "aws_cloudwatch_log_group" "pr" {
  name              = "/${var.name_prefix}/pr"
  retention_in_days = 14

  tags = {
    Example = "ci-pipelines"
  }
}
