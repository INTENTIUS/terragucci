# service-a's identity: one role and its inline policy.

resource "aws_iam_role" "service" {
  name = "demo-service-a"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "service" {
  name = "demo-service-a"
  role = aws_iam_role.service.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:ReceiveMessage"]
      Resource = "*"
    }]
  })
}
