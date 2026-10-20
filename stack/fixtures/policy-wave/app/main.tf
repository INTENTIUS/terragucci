# The one root of the policy-wave claim. Its state stays local, so the claim
# sees an apply as a terraform.tfstate with a resource in it.

terraform {
  backend "local" {}
}

resource "terraform_data" "probe" {
  input = "policy"
}
