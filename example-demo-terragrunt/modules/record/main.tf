# One terraform_data that holds a value, and an output that hands it on. Its
# input is known when it plans, so a unit that reads the output can be planned
# on it before this unit applies.

terraform {
  required_version = ">= 1.13"
}

variable "value" {
  type        = string
  description = "What this unit records."
}

resource "terraform_data" "this" {
  input = var.value
}

output "value" {
  value = terraform_data.this.input
}
