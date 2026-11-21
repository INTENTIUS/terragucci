terraform {
  backend "s3" {
    bucket         = "hs-tg-stage-soak-state"
    key            = "envs/dev/net.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "net" {
  input = "net-dev-v1"
}

output "id" {
  value = terraform_data.net.output
}
