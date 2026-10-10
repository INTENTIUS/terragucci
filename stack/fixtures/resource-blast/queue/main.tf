# The upstream root of the resource-blast claim: a queue, its policy, and a
# dead-letter queue, each ARN an output. Its state is a local file beside the
# roots, which worker reads by the same path. The claim stamps NAME.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
  }

  backend "local" {
    path = "../state/queue.tfstate"
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_sqs_queue" "jobs" {
  name                       = "NAME-jobs"
  visibility_timeout_seconds = 30
}

resource "aws_sqs_queue" "dead" {
  name = "NAME-dead"
}

locals {
  jobs_arn = aws_sqs_queue.jobs.arn
}

resource "aws_sqs_queue_policy" "jobs" {
  queue_url = aws_sqs_queue.jobs.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = "*", Action = "sqs:SendMessage", Resource = local.jobs_arn }]
  })
}

output "jobs_arn" {
  value = local.jobs_arn
}

output "dead_arn" {
  value = aws_sqs_queue.dead.arn
}
