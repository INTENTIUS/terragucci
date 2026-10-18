# app-02: an app on cluster-a.

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
    key            = "app-02.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

provider "aws" {
  region = "us-east-1"
}

# cluster-a's outputs: this root goes in the wave after cluster-a's.
data "terraform_remote_state" "cluster" {
  backend = "s3"
  config = {
    bucket         = "demo-fanout-state"
    key            = "cluster-a.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

resource "aws_sqs_queue" "work" {
  name = "fan-out-app-02"
  tags = {
    release = data.terraform_remote_state.cluster.outputs.release
    table   = data.terraform_remote_state.cluster.outputs.table
    tier    = "app"
  }
}
