# edge: routes to app on app's listener port, and lets through network's subnets.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  # The one choudoufu-specific thing in a component: where its resources are
  # recorded, in place of a state file. Atmos still generates backend.tf.json
  # from the stack; a live block ignores it (and choudoufu publishes the
  # component's outputs to it after an apply).
  live {
    estate = "ac-edge"

    record_store "s3" {
      bucket = "demo-atmos-choudoufu-records"
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

# Atmos passes the stack's name here.
variable "stage" {
  type = string
}

variable "listener_port" {
  type = number
}

variable "subnet_a_cidr" {
  type = string
}

# The ranges edge lets through: subnet a's.
resource "terraform_data" "allowlist" {
  input = [var.subnet_a_cidr]
}

resource "terraform_data" "upstream" {
  input = "http://app:${var.listener_port}"
}

output "upstream" {
  value = terraform_data.upstream.input
}
