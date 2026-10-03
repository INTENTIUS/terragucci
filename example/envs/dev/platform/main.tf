terraform {
  required_version = "~> 1.13.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  backend "s3" {
    bucket       = "shop-terraform-state"
    key          = "envs/dev/platform.tfstate"
    region       = "us-east-1"
    use_lockfile = true

    # Path-style S3 addresses work on AWS and on floci, the local stand-in.
    use_path_style = true
  }
}

provider "aws" {
  region            = "us-east-1"
  s3_use_path_style = true
}

# The dev environment's shared pieces. Every service root in envs/dev reads
# this root's outputs, so it is applied before them.

resource "aws_s3_bucket" "logs" {
  bucket = "shop-dev-logs"
}

output "logs_bucket" {
  value = aws_s3_bucket.logs.bucket
}
