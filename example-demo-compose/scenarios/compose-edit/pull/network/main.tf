# network: the producer. app reads its outputs through terraform_remote_state.

terraform {
  required_version = ">= 1.13"

  backend "s3" {
    bucket         = "demo-compose-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "http_proxy_port" {
  input = 8090
}

resource "terraform_data" "admin_port" {
  input = 9000
}

# A new value replaces this resource, which gate: on-destructive holds for an approval.
resource "terraform_data" "release" {
  triggers_replace = "r@CYCLE@"
  input            = "r@CYCLE@"
}

output "http_proxy_port" {
  value = terraform_data.http_proxy_port.input
}

output "admin_port" {
  value = terraform_data.admin_port.input
}
