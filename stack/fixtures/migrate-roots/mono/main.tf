# The one root of the migrate claims before the split: keep stays here, and a
# migration moves moved to a root of its own. Its state is in floci under
# @PREFIX@, which the claim fills in.

terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/mono.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "keep" {
  input = "keep"
}

resource "terraform_data" "moved" {
  input = "moved"
}
