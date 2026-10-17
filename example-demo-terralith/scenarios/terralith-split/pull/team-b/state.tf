# team-b's estate, carved from the shared root.
terraform {
  live {
    estate = "tl-team-b"

    record_store "s3" {
      bucket = "demo-terralith-records"
    }
  }
}
