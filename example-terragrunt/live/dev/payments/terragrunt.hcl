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

  mock_outputs = {
    logs_bucket = "mock-logs-bucket"
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}

inputs = {
  shop                  = local.common.locals.shop
  env                   = local.env.locals.env
  name                  = "payments"
  logs_bucket           = dependency.platform.outputs.logs_bucket
  job_retention_seconds = local.common.locals.job_retention_seconds
}
