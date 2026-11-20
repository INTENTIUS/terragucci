terraform {
  backend "s3" {
    bucket         = "hs-tg-rollback-state"
    key            = "envs/staging/net.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "net" {
  input = "net-staging-v1"
}

output "id" {
  value = terraform_data.net.output
}
