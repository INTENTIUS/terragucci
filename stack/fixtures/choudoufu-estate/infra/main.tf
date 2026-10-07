# One S3 bucket in a choudoufu estate on floci. estate.chdf.hcl beside this
# file turns live markers on, and there is no backend: the bucket's tags say
# who owns it, so the job's state file is only a cache.
#
# The endpoint and the credentials come from the job's environment
# (AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"

  # floci answers path-style S3 and has no STS account or metadata service.
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

resource "aws_s3_bucket" "this" {
  bucket = "terragucci-validate-cdf"
}

output "bucket" {
  value = aws_s3_bucket.this.bucket
}
