# edge: routes to app on the port app's records hold.

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
    estate = "cc-edge"

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

# app's recorded outputs.
data "terraform_estate_outputs" "app" {
  estate = "cc-app"
  names  = ["listener_port", "admin_listener_port"]
}

resource "aws_sqs_queue" "upstream" {
  name = "choudoufu-compose-upstream"
  tags = { upstream = "http://app:${data.terraform_estate_outputs.app.values.listener_port}" }
}

output "upstream" {
  value = aws_sqs_queue.upstream.tags.upstream
}

resource "aws_sqs_queue" "admin_upstream" {
  name = "choudoufu-compose-admin-upstream"
  tags = { upstream = "http://app:${data.terraform_estate_outputs.app.values.admin_listener_port}" }
}

output "admin_upstream" {
  value = aws_sqs_queue.admin_upstream.tags.upstream
}
