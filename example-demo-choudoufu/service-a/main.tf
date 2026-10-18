# service-a's logs and security groups. The log groups keep their events as long as
# the network estate says, and the security groups sit in its VPC.

resource "aws_cloudwatch_log_group" "app" {
  name              = "demo-service-a-app"
  retention_in_days = data.terraform_estate_outputs.network.values.log_retention_days
}

resource "aws_cloudwatch_log_group" "audit" {
  name              = "demo-service-a-audit"
  retention_in_days = data.terraform_estate_outputs.network.values.log_retention_days
}

resource "aws_security_group" "service" {
  name        = "demo-service-a"
  description = "service-a's tasks"
  vpc_id      = data.aws_vpc.network.id
}

resource "aws_security_group" "db" {
  name        = "demo-service-a-db"
  description = "service-a's database"
  vpc_id      = data.aws_vpc.network.id
}
