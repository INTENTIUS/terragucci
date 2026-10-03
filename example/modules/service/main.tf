# One service: somewhere to keep files, a queue of jobs, and a table of records.
# Every service root in envs/ calls this module, so a change here reaches all
# twelve of them at once.

variable "env" {
  type        = string
  description = "The environment: dev, staging or prod."
}

variable "name" {
  type        = string
  description = "The service's name, such as orders."
}

variable "logs_bucket" {
  type        = string
  description = "The environment's logs bucket, from the platform root. The service registers itself there."
}

variable "job_retention_seconds" {
  type        = number
  default     = 345600
  description = "How long the jobs queue keeps a job nobody has picked up, in seconds."
}

variable "records_key" {
  type        = string
  default     = "id"
  description = "The attribute the records table is keyed by. Changing it replaces the table."
}

variable "records_table" {
  type        = bool
  default     = true
  description = "Whether the service keeps a records table. Turning it off destroys the table."
}

variable "dead_letter_queue" {
  type        = bool
  default     = false
  description = "Give the jobs queue a dead-letter queue for jobs that keep failing."
}

locals {
  prefix = "shop-${var.env}-${var.name}"
}

resource "aws_s3_bucket" "files" {
  bucket = "${local.prefix}-files"
}

resource "aws_sqs_queue" "dead_letter" {
  count = var.dead_letter_queue ? 1 : 0

  name                       = "${local.prefix}-dead-letter"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 1209600
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${local.prefix}-jobs"
  visibility_timeout_seconds = 30
  message_retention_seconds  = var.job_retention_seconds

  redrive_policy = var.dead_letter_queue ? jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter[0].arn
    maxReceiveCount     = 5
  }) : null
}

resource "aws_dynamodb_table" "records" {
  count = var.records_table ? 1 : 0

  name         = "${local.prefix}-records"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = var.records_key

  attribute {
    name = var.records_key
    type = "S"
  }
}

# The service's entry in the environment's logs bucket. This is what makes the
# service depend on the platform root, so the platform always goes first.
resource "aws_s3_object" "registration" {
  bucket       = var.logs_bucket
  key          = "services/${var.name}.json"
  content_type = "application/json"
  content = jsonencode({
    service = var.name
    files   = aws_s3_bucket.files.bucket
    jobs    = aws_sqs_queue.jobs.name
    records = one(aws_dynamodb_table.records[*].name)
  })
}

output "jobs_queue" {
  value = aws_sqs_queue.jobs.name
}

output "records_table" {
  value = one(aws_dynamodb_table.records[*].name)
}
