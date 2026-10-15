# Every unit includes this file. It says where the unit keeps its state: one
# state per unit, under terragrunt/ in the demo's state bucket in floci.

terragrunt_version_constraint = ">= 1.1"

remote_state {
  backend = "s3"

  # The bucket exists already: stack/demo.sh makes it before the base is pushed.
  disable_init = true
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }

  config = {
    bucket       = "demo-terraform-state"
    key          = "terragrunt/${path_relative_to_include()}/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true

    # Path-style S3 addresses work on AWS and on floci, the local stand-in.
    use_path_style = true
  }
}
