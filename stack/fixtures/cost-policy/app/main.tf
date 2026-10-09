# The one root of the cost-policy claim: two resources, which cost.mjs prices
# at 10.00 a month each. Its state stays local, so the claim sees an apply as a
# terraform.tfstate with a resource in it.

terraform {
  backend "local" {}
}

resource "terraform_data" "one" {
  input = 1
}

resource "terraform_data" "two" {
  input = 2
}
