# cluster-a: sits on network, and six apps sit on it.

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
    estate = "fo-cluster-a"

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

# network's recorded outputs: this estate goes in the wave after network's.
data "terraform_estate_outputs" "network" {
  estate = "fo-network"
  names  = ["release"]
}

resource "aws_dynamodb_table" "jobs" {
  name         = "fan-out-choudoufu-cluster-a"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  tags = { release = data.terraform_estate_outputs.network.values.release, tier = "cluster" }
}

# cluster-a's own event queue.
resource "aws_sqs_queue" "events" {
  name                       = "fan-out-choudoufu-cluster-a-events"
  visibility_timeout_seconds = 120
  tags                       = { tier = "cluster" }
}

# Two of cluster-a's own resources that no change in the demo touches. They
# keep a one-block change under the 30% of the estate's blocks a cone plan may
# hold (choudoufu's live/PLAN-CONE.md), so the fix plans as a cone.
resource "aws_sqs_queue" "dead_letters" {
  name = "fan-out-choudoufu-cluster-a-dead-letters"
  tags = { tier = "cluster" }
}

resource "aws_cloudwatch_log_group" "jobs" {
  name              = "/fan-out-choudoufu/cluster-a/jobs"
  retention_in_days = 7
  tags              = { tier = "cluster" }
}

output "release" {
  value = data.terraform_estate_outputs.network.values.release
}

output "table" {
  value = aws_dynamodb_table.jobs.name
}
