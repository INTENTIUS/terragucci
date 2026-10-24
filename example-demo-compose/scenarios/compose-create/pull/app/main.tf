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

# Four resources placed in network's new subnet. Its id is unknown until the
# subnet is created, so the composed plan shows each of them as known after
# apply, and the same apply computes them once it has created the subnet.
resource "terraform_data" "security_group" {
  input = "sg in ${data.terraform_remote_state.network.outputs.subnet_id}"
}

resource "terraform_data" "route_table" {
  input = "rt in ${data.terraform_remote_state.network.outputs.subnet_id}"
}

resource "terraform_data" "instance" {
  input = "instance in ${data.terraform_remote_state.network.outputs.subnet_id}"
}

resource "terraform_data" "dns_record" {
  input = "app.${data.terraform_remote_state.network.outputs.subnet_id}.internal"
}

output "dns_name" {
  value = terraform_data.dns_record.input
}
