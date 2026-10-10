variable "stage" {
  type = string
}

variable "replicas" {
  type = number
}

resource "terraform_data" "app" {
  input = "${var.stage}:${var.replicas}"
}
