include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "${dirname(find_in_parent_folders("root.hcl"))}/modules/rev"
}

dependency "base" {
  config_path = "../base"

  mock_outputs                            = { rev = "mock" }
  mock_outputs_allowed_terraform_commands = ["validate"]
}

inputs = {
  rev = "${values.rev}-on-${dependency.base.outputs.rev}"
}
