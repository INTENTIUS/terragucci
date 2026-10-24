# estates: the composed root. It holds module calls and nothing else that
# creates a resource. Each called directory has its own `live` block (its
# estate and record store), so choudoufu plans and applies the three as one run
# and records each resource under its own estate.
#
# A module call takes no arguments: an estate's inputs are its own variables'
# defaults. Atmos writes the stack's vars to a varfile that only this root's
# variables see, so `stage` reaches the root and never the estates.
variable "stage" {
  type    = string
  default = ""
}

module "network" {
  source = "../network"
}

module "app" {
  source = "../app"
}

module "edge" {
  source = "../edge"
}

output "stage" {
  value = var.stage
}
