# One of five roots for the gated-waves claims. Its state is in floci under
# @PREFIX@, which the claim fills in; its one resource changes when rev.txt does.

terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/fleet/five.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "this" {
  input = trimspace(file("${path.module}/rev.txt"))
}
