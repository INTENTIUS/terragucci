include "root" {
  path = find_in_parent_folders("root.hcl")
}

# ledger: a new unit in this change. It sets up the bucket billing keeps its
# invoices in, and hands the bucket's name on as its output.
terraform {
  source = "../../modules/record"
}

inputs = {
  value = "demo-ledger-records"
}
