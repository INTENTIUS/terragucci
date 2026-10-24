# app: reads network's http_proxy_port and listens ten below it. edge reads
# app's output.

terraform {
  required_version = ">= 1.13"

  backend "s3" {
    bucket         = "demo-compose-state"
    key            = "app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket         = "demo-compose-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

resource "terraform_data" "listener" {
  input = data.terraform_remote_state.network.outputs.http_proxy_port - 10
}

output "listener_port" {
  value = terraform_data.listener.input
}

resource "terraform_data" "admin_listener" {
  input = data.terraform_remote_state.network.outputs.admin_port - 10
}

output "admin_listener_port" {
  value = terraform_data.admin_listener.input
}
