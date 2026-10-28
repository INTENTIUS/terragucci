# app in an estate: the live block replaces the s3 backend, and
# migrations/adopt-app.yml names the state it adopts.
terraform {
  live {
    estate = "hs-tg-migrate-app"

    record_store "s3" {
      bucket = "demo-live-records"
    }
  }
}

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

resource "aws_sqs_queue" "a" {
  name = "hs-tg-migrate-a"
}

resource "aws_sqs_queue" "b" {
  name = "hs-tg-migrate-b"
}
