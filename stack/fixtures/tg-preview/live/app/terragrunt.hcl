include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/rev"
}

# App reads net's rev, which net's plan knows.
dependency "net" {
  config_path = "../net"
}

inputs = {
  rev = trimspace(file("${get_terragrunt_dir()}/rev.txt"))
  up  = dependency.net.outputs.rev
}
