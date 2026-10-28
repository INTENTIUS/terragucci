# The app module: a function and the day-2 action that invokes it to rotate
# the app's key. The root invokes it as module.app.action.aws_lambda_invoke.rotate.
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "2.7.1"
    }
  }
}

variable "name" {
  type = string
}

provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true
}

data "archive_file" "rotate" {
  type        = "zip"
  output_path = "${path.module}/rotate.zip"
  source {
    filename = "index.js"
    content  = "exports.handler = async (event) => ({ rotated: event.key });"
  }
}

resource "aws_iam_role" "rotate" {
  name = "${var.name}-rotate"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_lambda_function" "rotate" {
  function_name    = "${var.name}-rotate"
  role             = aws_iam_role.rotate.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.rotate.output_path
  source_code_hash = data.archive_file.rotate.output_base64sha256
}

action "aws_lambda_invoke" "rotate" {
  config {
    function_name = aws_lambda_function.rotate.function_name
    payload       = jsonencode({ key = "orders-signing-moved" })
  }
}
