# app: reads network's http_proxy_port and listens ten below it. edge reads
# app's output.

terraform {
  required_version = ">= 1.13"

  backend "s3" {
    bucket         = "demo-terraform-state"
    key            = "app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket         = "demo-terraform-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

resource "terraform_data" "listener_port" {
  input = data.terraform_remote_state.network.outputs.http_proxy_port - 10
}

output "listener_port" {
  value = terraform_data.listener_port.input
}
