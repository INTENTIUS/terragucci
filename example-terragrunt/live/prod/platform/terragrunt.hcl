include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  common = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  env    = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

# The environment's shared pieces. Every service unit beside this one reads
# its outputs, so Terragrunt applies it first.
terraform {
  source = "../../../modules/platform"
}

inputs = {
  shop = local.common.locals.shop
  env  = local.env.locals.env
}
