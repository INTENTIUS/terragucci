# team-c's estate, carved from the terralith.
terraform {
  live {
    estate = "tl-team-c"

    record_store "s3" {
      bucket = "demo-terralith-records"
    }
  }
}
