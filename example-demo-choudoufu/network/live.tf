# The network estate. Its resources carry the ownership tags choudoufu writes
# (tofu-estate and tofu-address), and its records go to the one record store
# every estate of this repo shares, under its own prefix. It keeps no state file.
terraform {
  live {
    estate = "demo-network"

    record_store "s3" {
      bucket = "demo-live-records"
    }
  }
}
