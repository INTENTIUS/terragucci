# The downstream root of the linked-states claims, wave 2: it reads net's
# outputs through terraform_remote_state.

terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

data "terraform_remote_state" "net" {
  backend = "s3"
  config = {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/net.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

resource "terraform_data" "name" {
  input = data.terraform_remote_state.net.outputs.name
}

resource "terraform_data" "stamp" {
  input = "stamp-${data.terraform_remote_state.net.outputs.stamp}"
}
