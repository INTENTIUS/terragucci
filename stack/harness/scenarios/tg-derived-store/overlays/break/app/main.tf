# BREAK: the backend block is gone, so there is nothing to derive the store
# from; the store is local to the job, and the records never reach the bucket.
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

resource "aws_sqs_queue" "jobs" {
  name = "hs-derived-jobs"
}
