terraform {
  backend "s3" {
    bucket         = "hs-tg-stage-risk-state"
    key            = "app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "a" {
  input = "a-v1"
}

resource "terraform_data" "b" {
  input = "b-v1"
}
