# network: the producer. app reads its recorded outputs through terraform_estate_outputs.

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
    estate = "cc-network"

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

resource "aws_sqs_queue" "http_proxy_port" {
  name = "choudoufu-compose-http-proxy-port"
  tags = { port = "8080" }
}

# A new name replaces this queue, which gate: on-destructive holds for an approval.
resource "aws_sqs_queue" "release" {
  name = "choudoufu-compose-release-r0"
}

output "http_proxy_port" {
  value = tonumber(aws_sqs_queue.http_proxy_port.tags.port)
}
