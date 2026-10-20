include "root" {
  path = find_in_parent_folders("root.hcl")
}

# network: the producer. app reads its output through a dependency block.
terraform {
  source = "../../modules/record"
}

inputs = {
  value = "demo-network"
}
