# An environment's shared pieces: the bucket every service registers itself in.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

variable "shop" {
  type        = string
  description = "The prefix every name in the estate starts with."
}

variable "env" {
  type        = string
  description = "The environment: dev, staging or prod."
}

variable "name" {
  type        = string
  default     = "logs"
  description = "What the bucket holds, the last part of its name."
}

resource "aws_s3_bucket" "logs" {
  bucket = "${var.shop}-${var.env}-${var.name}"
}

output "logs_bucket" {
  value = aws_s3_bucket.logs.bucket
}
