include "root" {
  path = find_in_parent_folders("root.hcl")
}

dependency "network" {
  config_path = "../network"

  mock_outputs = {
    subnet_a_cidr = "10.0.1.0/24"
    subnet_b_cidr = "10.0.2.0/24"
  }
  mock_outputs_allowed_terraform_commands = ["plan", "show"]
  mock_outputs_merge_strategy_with_state  = "shallow"
}

dependency "app" {
  config_path = "../app"

  mock_outputs = {
    listener_port = 8070
  }
  mock_outputs_allowed_terraform_commands = ["plan", "show"]
  mock_outputs_merge_strategy_with_state  = "shallow"
}

inputs = {
  allowlist     = [dependency.network.outputs.subnet_a_cidr, dependency.network.outputs.subnet_b_cidr]
  listener_port = dependency.app.outputs.listener_port
}
