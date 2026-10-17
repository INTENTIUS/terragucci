# The identity layer: each team's role with an inline policy, and team-b's
# workers, one count-expanded block. The carve moves every team_b_ block to
# team-b's root (scripts/phases.py).

resource "aws_iam_role" "team_a_role" {
  name = "tl-team-a-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "team_a_inline" {
  name = "tl-team-a-inline"
  role = aws_iam_role.team_a_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_role" "team_b_role" {
  name = "tl-team-b-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "team_b_inline" {
  name = "tl-team-b-inline"
  role = aws_iam_role.team_b_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      Resource = "*"
    }]
  })
}

# Two instances of one block, told apart by count.index, so the carve moves a
# meta-argument shape too.
resource "aws_iam_role" "team_b_worker" {
  count = 2
  name  = "tl-team-b-worker-${count.index}-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role" "team_c_role" {
  name = "tl-team-c-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::100000000003:root" }
    }]
  })
}

resource "aws_iam_role_policy" "team_c_inline" {
  name = "tl-team-c-inline"
  role = aws_iam_role.team_c_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "*"
    }]
  })
}
