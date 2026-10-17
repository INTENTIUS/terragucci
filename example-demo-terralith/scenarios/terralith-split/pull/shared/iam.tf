# The identity layer the shared root keeps. team-b's moved to its own root.

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
