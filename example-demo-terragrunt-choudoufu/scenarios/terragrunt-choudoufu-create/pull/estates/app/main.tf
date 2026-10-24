# app: reads network's http_proxy_port and listens ten below it. edge reads app's output.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # No backend and no state file: each resource's record goes to the Terragrunt
  # demo's own record store, under this estate's prefix.
  live {
    estate = "tgc-app"

    record_store "s3" {
      bucket = "demo-terragrunt-choudoufu-records"
    }
  }
}

# Endpoint, region and credentials come from the environment. The provider
# asks STS for the account id: choudoufu refuses an identity it cannot resolve.
provider "aws" {
  region = "us-east-1"
  # The emulator's keys, named so choudoufu signs its removal sweep: floci, with
  # IAM enforcement on, refuses an unsigned tagging call, and a sweep that cannot
  # list would never find what a reset has to delete.
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
}

# network's recorded outputs; this estate goes in the wave after network's.
data "terraform_estate_outputs" "network" {
  estate = "tgc-network"
  names  = ["http_proxy_port", "subnet_id", "vpc_id"]
}

resource "terraform_data" "listener_port" {
  input = data.terraform_estate_outputs.network.values.http_proxy_port - 10
}

output "listener_port" {
  value = terraform_data.listener_port.input
}

# Four resources placed in network's new subnet. Its id is unknown until the
# subnet is created, so the composed plan shows each of them as known after
# apply, and the same apply computes them once it has created the subnet.
resource "aws_security_group" "security_group" {
  name   = "tgc-security-group"
  vpc_id = data.terraform_estate_outputs.network.values.vpc_id
}

resource "aws_route_table" "route_table" {
  vpc_id = data.terraform_estate_outputs.network.values.vpc_id
}

resource "aws_network_interface" "network_interface" {
  subnet_id = data.terraform_estate_outputs.network.values.subnet_id
}

resource "aws_route_table_association" "route_table_association" {
  subnet_id      = data.terraform_estate_outputs.network.values.subnet_id
  route_table_id = aws_route_table.route_table.id
}

output "dns_name" {
  value = "app-${aws_network_interface.network_interface.subnet_id}.demo.internal"
}
