# The pull request: a security group in the producer's VPC, so the network
# phase changes and the service phase re-reads the VPC by its markers
# (tg-compose-cross-estate).
resource "aws_security_group" "pr" {
  name   = "cross-estate-pr"
  vpc_id = aws_vpc.main.id
}
