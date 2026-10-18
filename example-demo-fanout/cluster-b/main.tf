# cluster-b: sits on network, and six apps sit on it.

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
    key            = "cluster-b.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

provider "aws" {
  region = "us-east-1"
}

# network's outputs: this root goes in the wave after network's.
data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket         = "demo-fanout-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

resource "aws_dynamodb_table" "jobs" {
  name         = "fan-out-cluster-b"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  tags = { release = data.terraform_remote_state.network.outputs.release, tier = "cluster" }
}

output "release" {
  value = data.terraform_remote_state.network.outputs.release
}

output "table" {
  value = aws_dynamodb_table.jobs.name
}
