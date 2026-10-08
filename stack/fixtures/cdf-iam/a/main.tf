# One EC2 instance in the choudoufu estate terragucci-smoke-iam-a, on the floci
# the cdf-iam smoke claim starts with IAM enforcement on. The claim changes
# the Name tag to a-2 and applies it as a role scoped to estate a.
#
# The endpoint and the credentials come from the job's environment
# (AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN).

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

  # floci has no metadata service, and the role may not call STS.
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
}

resource "aws_instance" "this" {
  ami           = "ami-12345678"
  instance_type = "t3.micro"

  tags = {
    Name = "a-1"
  }
}
