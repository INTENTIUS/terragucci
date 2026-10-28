terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
}

# One S3 bucket in a choudoufu estate on floci, as stack/fixtures/choudoufu-estate
# has it: the cdf-check and cdf-apply claims' root.
resource "aws_s3_bucket" "this" {
  bucket = "hs-tg-migrate-cdf"
}
