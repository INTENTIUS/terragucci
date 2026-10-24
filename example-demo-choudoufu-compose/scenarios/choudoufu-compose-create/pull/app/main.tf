# app: reads network's http_proxy_port and listens ten below it. edge reads app's output.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # No backend and no state file: each resource's record goes to the compose
  # demo's own record store, under this estate's prefix.
  live {
    estate = "cc-app"

    record_store "s3" {
      bucket = "demo-choudoufu-compose-records"
    }
  }
}

# Endpoint, region and credentials come from the environment. The provider
# asks STS for the account id: choudoufu refuses an identity it cannot resolve.
provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
}

# network's recorded outputs; this estate goes in the wave after network's.
data "terraform_estate_outputs" "network" {
  estate = "cc-network"
  names  = ["http_proxy_port", "subnet_id"]
}

resource "aws_sqs_queue" "listener" {
  name = "choudoufu-compose-listener"
  tags = { port = tostring(data.terraform_estate_outputs.network.values.http_proxy_port - 10) }
}

output "listener_port" {
  value = tonumber(aws_sqs_queue.listener.tags.port)
}

# Four resources placed in network's new subnet. Its id is unknown until the
# subnet is created, so the composed plan shows each of them as known after
# apply, and the same apply computes them once it has created the subnet.
resource "aws_sqs_queue" "security_group_queue" {
  name = "choudoufu-compose-security-group"
  tags = { placement = "sg in ${data.terraform_estate_outputs.network.values.subnet_id}" }
}

resource "aws_sqs_queue" "route_table_queue" {
  name = "choudoufu-compose-route-table"
  tags = { placement = "rt in ${data.terraform_estate_outputs.network.values.subnet_id}" }
}

resource "aws_sqs_queue" "instance_queue" {
  name = "choudoufu-compose-instance"
  tags = { placement = "instance in ${data.terraform_estate_outputs.network.values.subnet_id}" }
}

resource "aws_sqs_queue" "dns_record_queue" {
  name = "choudoufu-compose-dns-record"
  tags = { dns = "app.${data.terraform_estate_outputs.network.values.subnet_id}.internal" }
}

output "dns_name" {
  value = aws_sqs_queue.dns_record_queue.tags.dns
}
