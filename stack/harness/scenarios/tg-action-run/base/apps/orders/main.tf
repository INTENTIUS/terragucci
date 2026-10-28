# The app root: one module call, as a template's app root has. Its state is
# in floci, so the action's plan reads what the base push applied.
terraform {
  backend "s3" {
    bucket         = "hs-tg-action-run-state"
    key            = "apps/orders.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

module "app" {
  source = "../../modules/app"
  name   = "hs-tg-action-run-orders"
}
