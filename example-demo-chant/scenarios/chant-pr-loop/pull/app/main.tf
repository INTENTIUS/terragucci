# app: reads network's port, and exposes the URL edge reads.

terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket         = "demo-chant-state"
    key            = "app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

variable "network_port" {
  type = number
}

resource "terraform_data" "listener_port" {
  input = var.network_port + 1000
}

output "url" {
  value = "http://app:${terraform_data.listener_port.input}"
}

# The pull request's change: a health check on app's own listener.
resource "terraform_data" "health_check" {
  input = "http://app:${terraform_data.listener_port.input}/healthz"
}
