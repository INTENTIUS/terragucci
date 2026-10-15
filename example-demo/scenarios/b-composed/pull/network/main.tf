# network: the producer. app reads its output through terraform_remote_state.

terraform {
  backend "s3" {
    bucket         = "demo-terraform-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "http_proxy_port" {
  input = 8080
}

# A new value replaces this resource, which gate: on-destructive holds for an approval.
resource "terraform_data" "release" {
  triggers_replace = "r0"
  input            = "r0"
}

# A new subnet. Its id is chosen when it is created, so a plan shows it as
# known after apply until it is created.
resource "terraform_data" "subnet" {
  input = "10.0.1.0/24"
}

output "http_proxy_port" {
  value = terraform_data.http_proxy_port.input
}

output "subnet_id" {
  value = terraform_data.subnet.id
}
