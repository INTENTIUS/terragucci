# network: the producer. app reads its output through terraform_remote_state.

terraform {
  required_version = ">= 1.13"

  backend "s3" {
    bucket         = "demo-terraform-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "http_proxy_port" {
  input = 9090
}

# A new value replaces this resource, which gate: on-destructive holds for an approval.
resource "terraform_data" "release" {
  triggers_replace = "r0"
  input            = "r0"
}

output "http_proxy_port" {
  value = terraform_data.http_proxy_port.output
}
