include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/record"
}

# billing: a new unit in the same change, which reads the bucket's name from
# ledger. ledger has no state yet, so Terragrunt on its own would hand billing
# mock-bucket for its plan. terragucci plans billing on the name from ledger's
# plan instead, and refuses a plan that would read the mock.
dependency "ledger" {
  config_path = "../ledger"

  mock_outputs = {
    value = "mock-bucket"
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}

inputs = {
  value = "invoices in ${dependency.ledger.outputs.value}"
}
