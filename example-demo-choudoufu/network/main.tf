# The network every service runs in: one VPC, two subnets and a shared
# security group. The services find the VPC by its ownership tags.

resource "aws_vpc" "main" {
  cidr_block = "10.52.0.0/16"

  tags = {
    Name = "demo-network-vpc"
  }
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.52.1.0/24"
  availability_zone = "us-east-1a"

  tags = {
    Name = "demo-network-a"
  }
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.52.2.0/24"
  availability_zone = "us-east-1b"

  tags = {
    Name = "demo-network-b"
  }
}

resource "aws_security_group" "shared" {
  name        = "demo-network-shared"
  description = "Egress every service shares"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
