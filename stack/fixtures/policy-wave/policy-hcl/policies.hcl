# An HCP Terraform policy set for the policy-hcl claim: one mandatory policy
# that denies terraform_data, and one advisory policy that only warns.
policy "no_terraform_data" {
  query             = "data.terraform.policies.no_terraform_data.deny"
  enforcement_level = "mandatory"
}

policy "probe_note" {
  query             = "data.terraform.policies.probe_note.deny"
  enforcement_level = "advisory"
}
