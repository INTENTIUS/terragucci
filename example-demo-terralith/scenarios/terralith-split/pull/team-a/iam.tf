# team-a's identity resources, moved from the terralith's iam.tf.

resource "aws_iam_role" "team_0000_role" {
  name = "tl-team-0000-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "team_0000_inline" {
  name = "tl-team-0000-inline"
  role = aws_iam_role.team_0000_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:ListBucket"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_policy" "team_0000_policy" {
  name = "tl-team-0000-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:*"]
      Resource = "arn:aws:s3:::terralith-shared-bucket/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "team_0000_managed_attach" {
  role       = aws_iam_role.team_0000_role.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "team_0000_custom_attach" {
  role       = aws_iam_role.team_0000_role.name
  policy_arn = aws_iam_policy.team_0000_policy.arn
}

resource "aws_iam_instance_profile" "team_0000_profile" {
  name = "tl-team-0000-profile"
  role = aws_iam_role.team_0000_role.name
}

resource "aws_iam_role" "team_0001_role" {
  name = "tl-team-0001-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { AWS = "arn:aws:iam::100000000001:root" }
    }]
  })
}

resource "aws_iam_role_policy" "team_0001_inline" {
  name = "tl-team-0001-inline"
  role = aws_iam_role.team_0001_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_policy" "team_0001_policy" {
  name = "tl-team-0001-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "arn:aws:s3:::tl-team-0001-data/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "team_0001_managed_attach" {
  role       = aws_iam_role.team_0001_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "team_0001_custom_attach" {
  role       = aws_iam_role.team_0001_role.name
  policy_arn = aws_iam_policy.team_0001_policy.arn
}

resource "aws_iam_instance_profile" "team_0001_profile" {
  name = "tl-team-0001-profile"
  role = aws_iam_role.team_0001_role.name
}
