terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }
}

variable "bucket" {
  type = string
}

resource "aws_s3_bucket" "this" {
  bucket = var.bucket
}

output "bucket" {
  value = aws_s3_bucket.this.bucket
}
