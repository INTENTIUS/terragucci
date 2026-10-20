# network: the shared root. Both clusters read its outputs, and every app reads them through its cluster.

terraform {
  required_version = ">= 1.13"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  backend "s3" {
    bucket         = "demo-fanout-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

provider "aws" {
  region = "us-east-1"
}

locals {
  # The release every root of the estate tags itself with. A pull request that
  # changes it reaches all fifteen roots.
  release = "r0"
}

resource "aws_sqs_queue" "events" {
  name                       = "fan-out-network-events"
  visibility_timeout_seconds = 30
  tags                       = { release = local.release, tier = "network" }
}

output "release" {
  value = local.release
}

output "events_queue" {
  value = aws_sqs_queue.events.name
}
