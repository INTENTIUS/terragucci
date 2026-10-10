# The root of the unlock-state claim. Its apply sleeps for the seconds in
# hold.txt while it holds the state's lock file, so the claim can kill it
# mid-apply. Its state is in floci under @PREFIX@, which the claim fills in.

terraform {
  backend "s3" {
    bucket         = "shop-terraform-state"
    key            = "@PREFIX@/slow.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "slow" {
  input = trimspace(file("${path.module}/hold.txt"))

  provisioner "local-exec" {
    command = "sleep ${self.input}"
  }
}
