# The change: a second queue, recorded in the derived store.
resource "aws_sqs_queue" "extra" {
  name = "hs-derived-extra"
}
