variable "stage" {
  type = string
}

variable "replicas" {
  type = number
}

# Read from vpc's state by the stack (!terraform.state); null would be Atmos's
# stand-in for an upstream nothing applied.
variable "vpc_cidr" {
  type     = string
  nullable = true
}

resource "terraform_data" "app" {
  input = {
    stage    = var.stage
    replicas = var.replicas
    vpc      = var.vpc_cidr
  }
}
