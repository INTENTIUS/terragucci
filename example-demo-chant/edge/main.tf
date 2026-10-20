# edge: reads app's URL.

terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket         = "demo-chant-state"
    key            = "edge.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

variable "app_url" {
  type = string
}

resource "terraform_data" "upstream" {
  input = var.app_url
}
