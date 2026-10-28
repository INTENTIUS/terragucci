# A stock root: its state is app.tfstate in a versioned bucket, applied by
# choudoufu as stock OpenTofu, until the adopt pull request takes it into an
# estate.
terraform {
  backend "s3" {
    bucket         = "hs-tg-migrate-state"
    key            = "app.tfstate"
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

resource "aws_sqs_queue" "a" {
  name = "hs-tg-migrate-a"
}

resource "aws_sqs_queue" "b" {
  name = "hs-tg-migrate-b"
}
