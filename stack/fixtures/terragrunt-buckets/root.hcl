# Two Terragrunt units, an implicit stack with no terragrunt.stack.hcl, each
# one S3 bucket in floci. Every unit includes this file, which writes the AWS
# provider into the unit. State stays local to the job, as the s3-bucket
# fixture's does.
#
# The endpoint and the credentials come from the job's environment
# (AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<-EOF
    provider "aws" {
      region                      = "us-east-1"
      s3_use_path_style           = true
      skip_credentials_validation = true
      skip_requesting_account_id  = true
      skip_metadata_api_check     = true
    }
  EOF
}
