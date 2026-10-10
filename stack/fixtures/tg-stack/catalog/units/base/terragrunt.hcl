include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "${get_repo_root()}/modules/rev"
}

inputs = {
  rev = values.rev
}
