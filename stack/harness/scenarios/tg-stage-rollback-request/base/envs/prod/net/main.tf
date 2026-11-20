terraform {
  backend "s3" {
    bucket         = "hs-tg-stage-rollback-request-state"
    key            = "envs/prod/net.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "net" {
  input = "net-prod-v1"
}

output "id" {
  value = terraform_data.net.output
}
