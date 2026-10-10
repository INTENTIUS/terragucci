# The downstream root of the linked-plan-local claim, wave 2: it reads net's
# outputs through terraform_remote_state on the local backend.

terraform {
  backend "local" {
    path = "../state/app.tfstate"
  }
}

data "terraform_remote_state" "net" {
  backend = "local"
  config = {
    path = "../state/net.tfstate"
  }
}

resource "terraform_data" "name" {
  input = data.terraform_remote_state.net.outputs.name
}

resource "terraform_data" "stamp" {
  input = "stamp-${data.terraform_remote_state.net.outputs.stamp}"
}
