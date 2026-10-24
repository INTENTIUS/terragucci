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
  names  = ["http_proxy_port", "vpc_id"]
}

resource "aws_route53_zone" "internal" {
  name = "demo.internal"

  vpc {
    vpc_id = data.terraform_estate_outputs.network.values.vpc_id
  }
}

resource "aws_sqs_queue" "listener" {
  name = "choudoufu-compose-listener"
  tags = { port = tostring(data.terraform_estate_outputs.network.values.http_proxy_port - 10) }
}

output "listener_port" {
  value = tonumber(aws_sqs_queue.listener.tags.port)
}
