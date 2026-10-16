# network: the producer. app reads its port through stackOutput() in
# estate.component.ts, which chant passes to app as a variable.

terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket         = "demo-chant-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "http_proxy_port" {
  input = 8080
}

output "http_proxy_port" {
  value = terraform_data.http_proxy_port.input
}

# The pull request's change: a subnet. network's output stays the same, so app
# plans on the port network has now.
resource "terraform_data" "subnet" {
  input = "10.0.1.0/24"
}
