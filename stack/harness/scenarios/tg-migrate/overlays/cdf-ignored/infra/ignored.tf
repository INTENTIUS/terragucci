# A bucket whose lifecycle ignores its tags: choudoufu's live-check refuses
# it, since the tags are the ownership markers (the cdf-check claim).
resource "aws_s3_bucket" "ignored" {
  bucket = "hs-tg-migrate-ignored"

  lifecycle {
    ignore_changes = [tags]
  }
}
