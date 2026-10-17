# The terralith as a choudoufu estate: its resources carry the ownership tags
# live-import stamps, and it keeps no state file.
terraform {
  live {
    estate = "tl-terralith"

    record_store "s3" {
      bucket = "demo-terralith-records"
    }
  }
}
