# The state of the estate, in floci, so each wave reads what the last applied
# (the arm itself keeps local state).
terraform {
  backend "s3" {
    bucket         = "hs-multi-region-state"
    key            = "multi-region/terraform.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}
