# The push after the killed wave: its wave takes over the row the killed one
# left held and applies both (tg-estate-overlap).
resource "aws_sqs_queue" "next" {
  name = "hs-overlap-app-01-next"
}
