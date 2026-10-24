# edge: routes to app on the port app's state holds.

terraform {
  required_version = ">= 1.13"

  backend "s3" {
    bucket         = "demo-compose-state"
    key            = "edge.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

data "terraform_remote_state" "app" {
  backend = "s3"
  config = {
    bucket         = "demo-compose-state"
    key            = "app.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

resource "terraform_data" "upstream" {
  input = "http://app:${data.terraform_remote_state.app.outputs.listener_port}"
}

output "upstream" {
  value = terraform_data.upstream.input
}

# An address of app's that is built from the subnet's id.
resource "terraform_data" "dns_upstream" {
  input = "http://${data.terraform_remote_state.app.outputs.dns_name}:${data.terraform_remote_state.app.outputs.listener_port}"
}

output "dns_upstream" {
  value = terraform_data.dns_upstream.input
}

resource "terraform_data" "load_balancer_upstream" {
  input = "http://${data.terraform_remote_state.app.outputs.load_balancer_address}:${data.terraform_remote_state.app.outputs.listener_port}"
}

output "load_balancer_upstream" {
  value = terraform_data.load_balancer_upstream.input
}
