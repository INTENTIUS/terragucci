# The cost-policy claim's policy set: one mandatory policy on cost.
policy "cost_limit" {
  query             = "data.terraform.policies.cost_limit.deny"
  enforcement_level = "mandatory"
}
