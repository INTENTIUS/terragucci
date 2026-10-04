# Settings every unit shares. Units read it with read_terragrunt_config.
locals {
  # Every name in the estate starts with this.
  shop = "shop-tg"

  # How long a jobs queue keeps a job nobody picked up, in seconds.
  job_retention_seconds = 345600
}
