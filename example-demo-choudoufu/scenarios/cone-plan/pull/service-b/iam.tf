# service-b's identity: one role and its inline policy.

resource "aws_iam_role" "service" {
  name = "demo-service-b"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "service" {
  name = "demo-service-b"
  role = aws_iam_role.service.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket", "s3:PutObject"]
      Resource = "*"
    }]
  })
}
