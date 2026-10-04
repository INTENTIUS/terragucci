include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  common = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  env    = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "../../../modules/service"
}

dependency "platform" {
  config_path = "../platform"

  # No allow-list: Terragrunt then lets the mock stand in for every command,
  # apply included. terragucci's tips name it (TF041).
  mock_outputs = {
    logs_bucket = "mock-logs-bucket"
  }
}

inputs = {
  shop                  = local.common.locals.shop
  env                   = local.env.locals.env
  name                  = "email"
  logs_bucket           = dependency.platform.outputs.logs_bucket
  job_retention_seconds = local.common.locals.job_retention_seconds
}
