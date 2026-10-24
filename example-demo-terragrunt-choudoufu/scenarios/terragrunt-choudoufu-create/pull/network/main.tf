terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

variable "vpc_cidr" {
  type = string
}

variable "subnet_a_cidr" {
  type = string
}

variable "subnet_b_cidr" {
  type = string
}

variable "http_proxy_port" {
  type = number
}

# A terraform_data holds a value and creates nothing in the cloud, so a plan and
# an apply of it take no time. Outputs read `input`, which is known at plan.
resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr
}

resource "terraform_data" "http_proxy_port" {
  input = var.http_proxy_port
}

resource "aws_subnet" "subnet_a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = var.subnet_a_cidr
}

# The new subnet. Its id is chosen when it is created, so a plan shows it as known
# after apply.
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
  value = var.subnet_a_cidr
}

output "http_proxy_port" {
  value = terraform_data.http_proxy_port.input
}

output "subnet_b_id" {
  value = aws_subnet.subnet_b.id
}

output "subnet_b_cidr" {
  value = var.subnet_b_cidr
}
