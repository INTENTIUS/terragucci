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
