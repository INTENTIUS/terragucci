# The upstream root of the linked-states claims, wave 1. Its state is in floci
# under @PREFIX@, which the claim fills in. `name` is known when it plans;
# `stamp` is known only once it applies a new rev.txt.

terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/net.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
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
