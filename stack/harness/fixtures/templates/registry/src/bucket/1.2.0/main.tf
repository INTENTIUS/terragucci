# acme/bucket/aws 1.2.0: the harness's app template (stack/harness/fixtures/templates).
# The registry protocol files under registry/v1 point a download of 1.2.0 here.
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

variable "bucket_name" {
  type        = string
  description = "The bucket's name, unique in the account."
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
  tags   = var.tags
}

output "bucket_arn" {
  description = "The bucket's ARN."
  value       = aws_s3_bucket.this.arn
}

output "bucket_name" {
  description = "The bucket's name."
  value       = aws_s3_bucket.this.bucket
}
