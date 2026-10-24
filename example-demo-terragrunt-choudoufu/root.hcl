# Every unit includes this file. It names choudoufu as the binary Terragrunt
# runs, in place of tofu. There is no remote_state block: the estates under
# estates/ keep their records in one record store, set by each estate's own
# `live` block, and choudoufu takes no backend beside it.
terraform_binary = "choudoufu"

terragrunt_version_constraint = ">= 1.1"
