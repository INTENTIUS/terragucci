# The app billing, from the template acme/bucket/aws. Written by chant from a template request; a rollout moves the version.

module "app" {
  source  = "modules.harness.local/acme/bucket/aws"
  version = "1.2.0"

  bucket_name = "hs-tgag-billing"
  tags        = {}
}

output "app_bucket_arn" {
  value       = module.app.bucket_arn
  description = "The bucket's ARN."
}

output "app_bucket_name" {
  value       = module.app.bucket_name
  description = "The bucket's name."
}

