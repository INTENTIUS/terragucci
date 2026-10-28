# BREAK: a queue whose lifecycle ignores its tags, which choudoufu's
# live-check refuses because the tags are the ownership markers. Every pull
# request of the break run carries it, so its plan fails and nothing applies
# (tg-compose-atmos).
resource "aws_sqs_queue" "break" {
  name = "ac-break"

  lifecycle {
    ignore_changes = [tags]
  }
}
