# BREAK: a log group whose lifecycle ignores its tags, which choudoufu's
# live-check refuses because the tags are the ownership markers. Every pull
# request of the break run carries it, so live-check goes red and nothing
# merges into an apply (tg-compose-ci-pipelines).
resource "aws_cloudwatch_log_group" "break" {
  name = "/${var.name_prefix}/break"

  lifecycle {
    ignore_changes = [tags]
  }
}
