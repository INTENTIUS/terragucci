# The downstream root of the resource-blast claim: a function that reads the
# jobs queue's ARN through terraform_remote_state, the mapping that feeds it,
# and a log group that reads only the dead-letter queue's. The claim stamps
# NAME.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  backend "local" {
    path = "../state/worker.tfstate"
  }
}

provider "aws" {
  region = "us-east-1"
}

data "terraform_remote_state" "queue" {
  backend = "local"
  config = {
    path = "../state/queue.tfstate"
  }
}

resource "aws_lambda_function" "worker" {
  function_name = "NAME-worker"
  role          = "arn:aws:iam::000000000000:role/worker"
  package_type  = "Image"
  image_uri     = "000000000000.dkr.ecr.us-east-1.amazonaws.com/worker:1"

  environment {
    variables = {
      QUEUE_ARN = data.terraform_remote_state.queue.outputs.jobs_arn
    }
  }

  # floci answers with an empty image_config, which would plan as a change.
  lifecycle {
    ignore_changes = [image_config]
  }
}

resource "aws_lambda_event_source_mapping" "jobs" {
  event_source_arn = data.terraform_remote_state.queue.outputs.jobs_arn
  function_name    = aws_lambda_function.worker.arn
}

resource "aws_cloudwatch_log_group" "dead" {
  name = "/NAME/${element(split(":", data.terraform_remote_state.queue.outputs.dead_arn), 5)}"
}
