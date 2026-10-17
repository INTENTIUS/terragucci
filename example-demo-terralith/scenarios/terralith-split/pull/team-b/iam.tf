# team-b's identity resources, moved from the terralith's iam.tf.

resource "aws_iam_role" "team_0002_role" {
  name = "tl-team-0002-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "team_0002_inline" {
  name = "tl-team-0002-inline"
  role = aws_iam_role.team_0002_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_policy" "team_0002_policy" {
  name = "tl-team-0002-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cloudtrail:LookupEvents", "config:Get*", "config:Describe*"]
      Resource = "arn:aws:s3:::terralith-shared-bucket/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "team_0002_managed_attach" {
  role       = aws_iam_role.team_0002_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "team_0002_custom_attach" {
  role       = aws_iam_role.team_0002_role.name
  policy_arn = aws_iam_policy.team_0002_policy.arn
}

resource "aws_iam_instance_profile" "team_0002_profile" {
  name = "tl-team-0002-profile"
  role = aws_iam_role.team_0002_role.name
}

resource "aws_iam_role" "team_0003_role" {
  name = "tl-team-0003-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::100000000003:root" }
    }]
  })
}

resource "aws_iam_role_policy" "team_0003_inline" {
  name = "tl-team-0003-inline"
  role = aws_iam_role.team_0003_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_policy" "team_0003_policy" {
  name = "tl-team-0003-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "arn:aws:s3:::tl-team-0003-data/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "team_0003_managed_attach" {
  role       = aws_iam_role.team_0003_role.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "team_0003_custom_attach" {
  role       = aws_iam_role.team_0003_role.name
  policy_arn = aws_iam_policy.team_0003_policy.arn
}

resource "aws_iam_instance_profile" "team_0003_profile" {
  name = "tl-team-0003-profile"
  role = aws_iam_role.team_0003_role.name
}
