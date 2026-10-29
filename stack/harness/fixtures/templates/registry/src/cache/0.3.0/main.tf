# acme/cache/aws 0.3.0: the harness's add-on template (stack/harness/fixtures/templates),
# a cache bucket beside an app's bucket. An add-on request passes the app's
# bucket as origin_arn = app.bucket_arn.
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

variable "cache_name" {
  type        = string
  description = "The cache bucket's name."
}

variable "origin_arn" {
  type        = string
  description = "The ARN of the bucket the cache stands in front of."
}

resource "aws_s3_bucket" "cache" {
  bucket = var.cache_name
  tags = {
    origin = var.origin_arn
  }
}

output "cache_arn" {
  description = "The cache bucket's ARN."
  value       = aws_s3_bucket.cache.arn
}
