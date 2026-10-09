# One resource whose input joins the unit's rev and what it reads from the unit before it.

variable "rev" {
  type = string
}

variable "up" {
  type    = string
  default = ""
}

resource "terraform_data" "this" {
  input = "${var.rev}-${var.up}"
}

# Known when the unit plans.
output "rev" {
  value = "r${var.rev}"
}

# Known only once the resource applies.
output "out" {
  value = terraform_data.this.output
}
