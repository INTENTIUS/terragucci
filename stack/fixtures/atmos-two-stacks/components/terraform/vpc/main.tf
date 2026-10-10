variable "stage" {
  type = string
}

variable "cidr" {
  type = string
}

resource "terraform_data" "vpc" {
  input = "${var.stage}:${var.cidr}"
}

output "cidr" {
  value = var.cidr
}
