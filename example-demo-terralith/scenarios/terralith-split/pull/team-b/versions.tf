# versions.tf - provider wiring only, copied from the terralith's. The
# estate's live block is in state.tf.
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
  # composes loses its account segment, and choudoufu refuses an identity
  # it cannot resolve (issue #572) rather than propose a duplicate.
  # Floci and real AWS both answer STS GetCallerIdentity, so
  # letting the provider ask costs one request and keeps this fixture
  # plannable. Same call live/e2e/estate/versions.tf made under P2.3.
}
