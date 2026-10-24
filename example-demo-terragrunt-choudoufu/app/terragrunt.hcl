include "root" {
  path = find_in_parent_folders("root.hcl")
}

dependency "network" {
  config_path = "../network"

  # Stand-ins until network has applied an output; real outputs win.
  mock_outputs = {
    vpc_id          = "vpc-mock"
    subnet_a_id     = "subnet-mock"
    http_proxy_port = 8080
  }
  mock_outputs_allowed_terraform_commands = ["plan", "show"]
  mock_outputs_merge_strategy_with_state  = "shallow"
}

inputs = {
  vpc_id          = dependency.network.outputs.vpc_id
  subnet_a_id     = dependency.network.outputs.subnet_a_id
  http_proxy_port = dependency.network.outputs.http_proxy_port
}
