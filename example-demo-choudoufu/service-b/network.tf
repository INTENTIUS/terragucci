# What service-b reads from the network estate: the retention it publishes, and its
# VPC, found by the ownership tags choudoufu wrote on it.

data "terraform_estate_outputs" "network" {
  estate = "demo-network"
  names  = ["log_retention_days"]
}

data "aws_vpc" "network" {
  filter {
    name   = "tag:tofu-estate"
    values = ["demo-network"]
  }

  filter {
    name   = "tag:tofu-address"
    values = ["aws_vpc.main"]
  }
}
