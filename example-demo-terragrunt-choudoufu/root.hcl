# Every unit includes this file, as in any Terragrunt repo: the provider, the
# backend and the binary Terragrunt runs. The one line that is about choudoufu
# is terraform_binary; Terragrunt runs it where it would run tofu.
terraform_binary = "choudoufu"

terragrunt_version_constraint = ">= 1.1"

# Endpoint, region and credentials come from the environment. The provider asks
# STS for the account id: choudoufu refuses an identity it cannot resolve.
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF2
    provider "aws" {
      region = "us-east-1"
      # The emulator's keys, named so choudoufu signs its removal sweep: floci,
      # with IAM enforcement on, refuses an unsigned tagging call.
      access_key                  = "test"
      secret_key                  = "test"
      skip_credentials_validation = true
      skip_metadata_api_check     = true
      s3_use_path_style           = true
    }
  EOF2
}

# One state key per unit. The backend is generated, not declared with a
# remote_state block: Terragrunt reads a dependency's outputs straight from the
# state of a remote_state backend and never asks the binary, and a value that
# exists only after apply is not in that state yet. choudoufu keeps no state
# file; after an apply it publishes the unit's outputs to this key.
generate "backend" {
  path      = "backend.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF2
    terraform {
      backend "s3" {
        bucket         = "demo-terragrunt-choudoufu-state"
        key            = "${path_relative_to_include()}/terraform.tfstate"
        region         = "us-east-1"
        use_lockfile   = true
        use_path_style = true
      }
    }
  EOF2
}
