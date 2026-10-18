# app-01: an app on cluster-a.

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
    estate = "fo-app-01"

    record_store "s3" {
      bucket = "demo-live-records"
    }

    # The estate an operator also applies to from outside the pipeline (the
    # fan-out-choudoufu scenario). A resource of the estate no code here
    # declares is kept, so the pipeline's apply of its approved plan neither
    # destroys the operator's queue nor refuses because the estate now holds it.
    policy {
      undeclared_tagged = "keep"
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

# cluster-a's recorded outputs: this estate goes in the wave after cluster-a's.
data "terraform_estate_outputs" "cluster" {
  estate = "fo-cluster-a"
  names  = ["release", "table"]
}

resource "aws_sqs_queue" "work" {
  name = "fan-out-app-01"
  tags = {
    release = data.terraform_estate_outputs.cluster.values.release
    table   = data.terraform_estate_outputs.cluster.values.table
    tier    = "app"
  }
}
