include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/record"
}

# app reads network's output, so Terragrunt applies network first. The mock is
# allowed for validate and plan only, as example-terragrunt's service units do.
dependency "network" {
  config_path = "../network"

  mock_outputs = {
    value = "mock-network"
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}

inputs = {
  value = "app on ${dependency.network.outputs.value}"
}
