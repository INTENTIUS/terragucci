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

resource "terraform_data" "admin_upstream" {
  input = "http://app:${data.terraform_remote_state.app.outputs.admin_listener_port}"
}

output "admin_upstream" {
  value = terraform_data.admin_upstream.input
}
