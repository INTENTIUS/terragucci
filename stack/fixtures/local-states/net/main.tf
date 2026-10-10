# The upstream root of the linked-plan-local claim, wave 1. Its state is a
# local file beside the roots, which app reads by the same path.

terraform {
  backend "local" {
    path = "../state/net.tfstate"
  }
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
