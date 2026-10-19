# network: the shared estate. Both clusters read its outputs, and every app reads them through its cluster.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # No backend and no state file: each resource's record goes to the demo's
  # record store, under this estate's prefix.
  live {
    estate = "fo-network"

    record_store "s3" {
      bucket = "demo-live-records"
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

locals {
  # The release every estate tags its resources with. A pull request that
  # changes it reaches all fifteen estates.
  release = "r@CYCLE@"
}

resource "aws_sqs_queue" "events" {
  name                       = "fan-out-choudoufu-network-events"
  visibility_timeout_seconds = 30
  tags                       = { release = local.release, tier = "network" }
}

output "release" {
  value = local.release
}

output "events_queue" {
  value = aws_sqs_queue.events.name
}
