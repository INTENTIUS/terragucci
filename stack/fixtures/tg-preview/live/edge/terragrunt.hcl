include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/rev"
}

# Edge reads app's out, which app knows only once it applies.
dependency "app" {
  config_path = "../app"
}

inputs = {
  rev = trimspace(file("${get_terragrunt_dir()}/rev.txt"))
  up  = dependency.app.outputs.out
}
