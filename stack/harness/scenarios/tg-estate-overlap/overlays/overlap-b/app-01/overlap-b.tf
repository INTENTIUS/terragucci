# Pull request b: another queue of app-01's estate, opened beside a (tg-estate-overlap).
resource "aws_sqs_queue" "overlap_b" {
  name = "hs-overlap-app-01-b"
  tags = {
    tier = "app"
  }
}
