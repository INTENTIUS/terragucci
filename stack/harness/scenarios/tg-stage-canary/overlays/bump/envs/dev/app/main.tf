terraform {
  backend "s3" {
    bucket         = "hs-tg-stage-canary-state"
    key            = "envs/dev/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "app" {
  input = "app-dev-v2"
}

output "id" {
  value = terraform_data.app.output
}
