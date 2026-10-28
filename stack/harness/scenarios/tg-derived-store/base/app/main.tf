# The backend block stays: choudoufu ignores it for state and derives the
# record store from it.
terraform {
  backend "s3" {
    bucket         = "demo-live-records"
    key            = "hs-derived/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
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

resource "aws_sqs_queue" "jobs" {
  name = "hs-derived-jobs"
}
