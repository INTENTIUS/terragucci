# Every unit of the Terragrunt preview fixture includes this file. Its state
# is in floci under @PREFIX@, which the claim fills in.

remote_state {
  backend      = "s3"
  disable_init = true

  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }

  config = {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/${path_relative_to_include()}/terraform.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}
