# network: the producer. app reads its recorded outputs through terraform_estate_outputs.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # No backend and no state file: each resource's record goes to the compose
  # demo's own record store, under this estate's prefix.
  live {
    estate = "cc-network"

    record_store "s3" {
      bucket = "demo-choudoufu-compose-records"
    }
  }
}

# Endpoint, region and credentials come from the environment. The provider
# asks STS for the account id: choudoufu refuses an identity it cannot resolve.
provider "aws" {
  region = "us-east-1"
  # The emulator's keys, named so choudoufu signs its removal sweep: floci, with
  # IAM enforcement on, refuses an unsigned tagging call, and a sweep that cannot
  # list would never find what a reset has to delete.
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
}

# A terraform_data holds a value in a record and creates nothing in the cloud, so
# a plan and an apply of it take no time. Outputs read `input`, which is known at
# plan, so a changed port reaches the estates that read it in the same plan.
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "terraform_data" "http_proxy_port" {
  input = 8080
}

# A new subnet. Its id is chosen when it is created, so a plan shows it as
# known after apply until then.
resource "aws_subnet" "subnet" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "http_proxy_port" {
  value = terraform_data.http_proxy_port.input
}

output "subnet_id" {
  value = aws_subnet.subnet.id
}

output "subnet_cidr" {
  value = aws_subnet.subnet.cidr_block
}
