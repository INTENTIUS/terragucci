include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/rev"
}

# App goes out after net.
dependencies {
  paths = ["../net"]
}

inputs = {
  rev = trimspace(file("${get_terragrunt_dir()}/rev.txt"))
}
