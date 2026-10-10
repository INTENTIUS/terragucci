# One resource that changes when the value its unit passes does.

variable "rev" {
  type = string
}

resource "terraform_data" "this" {
  input = var.rev
}

output "rev" {
  value = terraform_data.this.output
}
