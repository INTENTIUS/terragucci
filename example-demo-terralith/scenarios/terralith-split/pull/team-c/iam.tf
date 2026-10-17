# team-c's identity resources, moved from the terralith's iam.tf.

resource "aws_iam_role" "team_0004_role" {
  name = "tl-team-0004-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "team_0004_inline" {
  name = "tl-team-0004-inline"
  role = aws_iam_role.team_0004_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_policy" "team_0004_policy" {
  name = "tl-team-0004-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:*"]
      Resource = "arn:aws:s3:::terralith-shared-bucket/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "team_0004_managed_attach" {
  role       = aws_iam_role.team_0004_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "team_0004_custom_attach" {
  role       = aws_iam_role.team_0004_role.name
  policy_arn = aws_iam_policy.team_0004_policy.arn
}

resource "aws_iam_instance_profile" "team_0004_profile" {
  name = "tl-team-0004-profile"
  role = aws_iam_role.team_0004_role.name
}

resource "aws_iam_role" "team_0005_role" {
  name = "tl-team-0005-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::100000000005:root" }
    }]
  })
}

resource "aws_iam_role_policy" "team_0005_inline" {
  name = "tl-team-0005-inline"
  role = aws_iam_role.team_0005_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_policy" "team_0005_policy" {
  name = "tl-team-0005-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "arn:aws:s3:::tl-team-0005-data/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "team_0005_managed_attach" {
  role       = aws_iam_role.team_0005_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "team_0005_custom_attach" {
  role       = aws_iam_role.team_0005_role.name
  policy_arn = aws_iam_policy.team_0005_policy.arn
}

resource "aws_iam_instance_profile" "team_0005_profile" {
  name = "tl-team-0005-profile"
  role = aws_iam_role.team_0005_role.name
}
