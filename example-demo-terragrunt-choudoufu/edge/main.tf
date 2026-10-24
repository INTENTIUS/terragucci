terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

variable "allowlist" {
  type = list(string)
}

variable "listener_port" {
  type = number
}

# The ranges edge lets through.
resource "terraform_data" "allowlist" {
  input = var.allowlist
}

resource "terraform_data" "upstream" {
  input = "http://app:${var.listener_port}"
}

output "upstream" {
  value = terraform_data.upstream.input
}
