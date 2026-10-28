# BREAK: every pull request of the break run carries this file, so a and b
# both change this one queue, and their two waves race for one record: one
# lands, the other fails its conditional write, and the run is caught at
# both-applied (tg-estate-overlap).
resource "aws_sqs_queue" "overlap_same" {
  name                       = "hs-overlap-app-01-same"
  visibility_timeout_seconds = 30
}
