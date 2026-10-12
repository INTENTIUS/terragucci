# The upstream root of the linked-backend-config claim, wave 1. Its backend
# block names no path: init takes it from backend.hcl, which terragucci.yml's
# TF_CLI_ARGS_init passes to every root's init.

terraform {
  backend "local" {}
}

resource "terraform_data" "this" {
  input = trimspace(file("${path.module}/rev.txt"))
}

output "name" {
  value = "net-${terraform_data.this.input}"
}

output "stamp" {
  value = terraform_data.this.output
}
