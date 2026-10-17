# team-b's estate, carved from the terralith.
terraform {
  live {
    estate = "tl-team-b"

    record_store "s3" {
      bucket = "demo-terralith-records"
    }
  }
}
