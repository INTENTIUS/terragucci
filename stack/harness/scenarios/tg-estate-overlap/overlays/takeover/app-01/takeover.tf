# A queue whose apply the scenario kills mid-run: the wave leaves its row
# held, and the next push's wave takes it over (tg-estate-overlap).
resource "aws_sqs_queue" "takeover" {
  name                       = "hs-overlap-app-01-takeover"
  visibility_timeout_seconds = 45
}
