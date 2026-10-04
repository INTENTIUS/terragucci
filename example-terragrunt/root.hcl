# Every unit includes this file. It says where the unit keeps its state and
# writes the AWS provider into the unit, so no unit repeats either.

terragrunt_version_constraint = ">= 1.1"

remote_state {
  backend = "s3"

  # terragucci's example writes backend.tf itself and lets the bucket exist
  # already, the way most accounts create their state bucket once, by hand.
  disable_init = true
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }

  config = {
    bucket       = "shop-terraform-state"
    key          = "terragrunt/${path_relative_to_include()}/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true

    # Path-style S3 addresses work on AWS and on floci, the local stand-in.
    use_path_style = true
  }
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    provider "aws" {
      region            = "us-east-1"
      s3_use_path_style = true
    }
  EOF
}
