# team-a's estate, carved from the terralith.
terraform {
  live {
    estate = "tl-team-a"

    record_store "s3" {
      bucket = "demo-terralith-records"
    }
  }
}
