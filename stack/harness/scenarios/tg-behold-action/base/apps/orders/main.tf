# The app orders, from the template acme/app/aws. Written by chant from a template request; a rollout moves the version.

module "app" {
  source  = "modules.harness.local/acme/app/aws"
  version = "1.0.0"

  name = "hs-tgbx-orders"
}

output "app_function_name" {
  value       = module.app.function_name
  description = "The app's function."
}
