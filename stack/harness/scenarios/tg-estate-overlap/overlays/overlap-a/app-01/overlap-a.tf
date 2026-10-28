# Pull request a: a queue of its own in app-01's estate (tg-estate-overlap).
resource "aws_sqs_queue" "overlap_a" {
  name = "hs-overlap-app-01-a"
  tags = {
    tier = "app"
  }
}
