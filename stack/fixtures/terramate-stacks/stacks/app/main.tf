terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "this" {
  input = "${local.owner}:${local.stack}:1"
}
