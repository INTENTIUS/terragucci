include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/bucket"
}

inputs = {
  bucket = "terragucci-validate-tg-one"
}
