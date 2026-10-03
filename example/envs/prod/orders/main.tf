terraform {
  required_version = "~> 1.13.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  backend "s3" {
    bucket       = "shop-terraform-state"
    key          = "envs/prod/orders.tfstate"
    region       = "us-east-1"
    use_lockfile = true

    # Path-style S3 addresses work on AWS and on floci, the local stand-in.
    use_path_style = true
  }
}

provider "aws" {
  region            = "us-east-1"
  s3_use_path_style = true
}

data "terraform_remote_state" "platform" {
  backend = "s3"
  config = {
    bucket         = "shop-terraform-state"
    key            = "envs/prod/platform.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

module "service" {
  source = "../../../modules/service"

  env         = "prod"
  name        = "orders"
  logs_bucket = data.terraform_remote_state.platform.outputs.logs_bucket
}

output "jobs_queue" {
  value = module.service.jobs_queue
}
