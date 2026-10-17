# team-b's identity resources, moved from the terralith's iam.tf.

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
