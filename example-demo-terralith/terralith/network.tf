# The shared layer: one VPC, subnet and security group that no team owns. It
# stays in the terralith when team-b is carved out.

resource "aws_vpc" "main" {
  cidr_block = "10.42.0.0/16"

  tags = {
    Name = "tl-vpc"
  }
}

resource "aws_subnet" "main" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.1.0/24"
  availability_zone = "us-east-1a"

  tags = {
    Name = "tl-subnet"
  }
}

resource "aws_security_group" "main" {
  name        = "tl-shared-sg"
  description = "The terralith's shared security group"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
