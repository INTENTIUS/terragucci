include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/rev"
}

# Edge goes out after app, so the fixture has three layers.
dependencies {
  paths = ["../app"]
}

inputs = {
  rev = trimspace(file("${get_terragrunt_dir()}/rev.txt"))
}
