terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

variable "vpc_id" {
  type = string
}

variable "subnet_a_id" {
  type = string
}

variable "http_proxy_port" {
  type = number
}

variable "admin_port" {
  type = number
}

resource "aws_security_group" "web" {
  name   = "tgc-web"
  vpc_id = var.vpc_id
}

resource "aws_network_interface" "web" {
  subnet_id = var.subnet_a_id
}

resource "terraform_data" "listener_port" {
  input = var.http_proxy_port - 10
}

output "listener_port" {
  value = terraform_data.listener_port.input
}

resource "terraform_data" "admin_listener_port" {
  input = var.admin_port - 10
}

output "admin_listener_port" {
  value = terraform_data.admin_listener_port.input
}
