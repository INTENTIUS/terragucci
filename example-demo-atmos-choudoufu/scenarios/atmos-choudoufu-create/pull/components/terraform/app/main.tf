# app: listens ten below network's proxy port. edge reads its output.

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
    estate = "ac-app"

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

# All four arrive from network's outputs, through !terraform.output in the stack.
variable "vpc_id" {
  type = string
}

variable "subnet_a_id" {
  type = string
}

variable "http_proxy_port" {
  type = number
}

variable "subnet_b_id" {
  type = string
}

# The estate already running: a security group in the VPC and an interface in
# subnet a.
resource "aws_security_group" "web" {
  name   = "ac-web"
  vpc_id = var.vpc_id
}

resource "aws_network_interface" "web" {
  subnet_id = var.subnet_a_id
}

# The one new resource: a worker in network's new subnet. The subnet's id does
# not exist until the apply creates it.
resource "aws_network_interface" "worker" {
  subnet_id = var.subnet_b_id
}

resource "terraform_data" "listener_port" {
  input = var.http_proxy_port - 10
}

output "listener_port" {
  value = terraform_data.listener_port.input
}
