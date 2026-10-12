terraform {
  backend "local" {}
}

variable "size" {
  type    = number
  default = 0
}

resource "terraform_data" "this" {
  input = var.size
}

# local.owner comes from common.tf, a symlink to ../../../shared/common.tf the claim makes.
resource "terraform_data" "owner" {
  input = local.owner
}
