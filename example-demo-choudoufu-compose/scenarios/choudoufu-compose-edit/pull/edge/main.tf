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

# app's recorded outputs.
data "terraform_estate_outputs" "app" {
  estate = "cc-app"
  names  = ["listener_port", "admin_listener_port"]
}

# The ranges edge lets through: subnet a's.
resource "terraform_data" "allowlist" {
  input = ["10.0.1.0/24"]
}

resource "terraform_data" "upstream" {
  input = "http://app:${data.terraform_estate_outputs.app.values.listener_port}"
}

output "upstream" {
  value = terraform_data.upstream.input
}

resource "terraform_data" "admin_upstream" {
  input = "http://app:${data.terraform_estate_outputs.app.values.admin_listener_port}"
}

output "admin_upstream" {
  value = terraform_data.admin_upstream.input
}
