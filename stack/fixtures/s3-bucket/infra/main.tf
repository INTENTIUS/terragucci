# One S3 bucket in floci. The smallest root that still needs a real provider,
# a real init and a real apply, which is what the stack's first claims check.
#
# The endpoint and the credentials come from the job's environment
# (AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY), so the same
# root plans against floci in a job and against nothing at all elsewhere.

terraform {
  required_version = "~> 1.13.0"

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

variable "bucket_name" {
  type    = string
  default = "terragucci-validate"
}

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
}

output "bucket" {
  value = aws_s3_bucket.this.bucket
}
