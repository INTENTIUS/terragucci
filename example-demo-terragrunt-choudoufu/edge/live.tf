# The only choudoufu-specific file in the unit: which estate it is and where its
# records go. choudoufu keeps a record per resource here in place of a state file.
terraform {
  live {
    estate = "tgc-edge"

    record_store "s3" {
      bucket = "demo-terragrunt-choudoufu-records"
    }
  }
}
