# network: the producer. app and edge read its outputs with !terraform.output in the stack.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # The one choudoufu-specific thing in a component: where its resources are
  # recorded, in place of a state file. Atmos still generates backend.tf.json
  # from the stack; a live block ignores it (and choudoufu publishes the
  # component's outputs to it after an apply).
  live {
    estate = "ac-network"

    record_store "s3" {
      bucket = "demo-atmos-choudoufu-records"
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

# Atmos passes the stack's name here.
variable "stage" {
  type = string
}

variable "http_proxy_port" {
  type = number
}

variable "subnet_a_cidr" {
  type = string
}

variable "subnet_b_cidr" {
  type = string
}

# A terraform_data holds a value in a record and creates nothing in the cloud, so
# a plan and an apply of it take no time.
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "terraform_data" "http_proxy_port" {
  input = var.http_proxy_port
}

# The estate already running: one subnet in the VPC.
resource "aws_subnet" "subnet_a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = var.subnet_a_cidr
}

# The new subnet. Its id is chosen when it is created, so the plan shows it as
# known after apply. Its range is a variable, known at plan.
resource "aws_subnet" "subnet_b" {
  vpc_id     = aws_vpc.main.id
  cidr_block = var.subnet_b_cidr
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "subnet_a_id" {
  value = aws_subnet.subnet_a.id
}

output "subnet_a_cidr" {
  value = aws_subnet.subnet_a.cidr_block
}

output "subnet_b_id" {
  value = aws_subnet.subnet_b.id
}

output "subnet_b_cidr" {
  value = aws_subnet.subnet_b.cidr_block
}

output "http_proxy_port" {
  value = terraform_data.http_proxy_port.input
}
