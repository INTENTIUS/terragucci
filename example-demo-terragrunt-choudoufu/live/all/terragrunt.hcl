include "root" {
  path = find_in_parent_folders("root.hcl")
}

# One unit for the three estates. The double slash makes Terragrunt copy all of
# estates/ into its cache and run in composed/, so the module calls there
# (../network, ../app, ../edge) resolve. One `terragrunt plan` is then one plan
# across the three estates, and one `terragrunt apply` is one apply.
terraform {
  source = "../../estates//composed"
}
