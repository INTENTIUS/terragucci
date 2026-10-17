# versions.tf - provider wiring only. Copied from the terralith's versions.tf.
# No backend block: local state, same as any stock Terraform root module
# before migration. No "live" block anywhere in this estate - see #564.
#
# Endpoint, region and credentials come from the environment
# (AWS_ENDPOINT_URL, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY);
# the provider block carries only the flags that have no such form.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.59.0"
    }
  }
}

provider "aws" {
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  # skip_requesting_account_id is deliberately absent (issue #628). With it
  # set the provider's account id is empty, every ARN-shaped identity it
  # composes loses its account segment, and ECS identity resolution fails
  # (issue #572) - which choudoufu now refuses on rather than proposing a
  # duplicate. Floci and real AWS both answer STS GetCallerIdentity, so
  # letting the provider ask costs one request and keeps this fixture
  # plannable. Same call live/e2e/estate/versions.tf made under P2.3.
}
