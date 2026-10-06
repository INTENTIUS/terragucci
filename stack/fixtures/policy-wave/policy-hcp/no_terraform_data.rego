# An HCP Terraform policy, as a policy set holds it: the plan at input.plan,
# the run at input.run. It runs unchanged with `input: hcp`.
package terraform.policies.no_terraform_data

import rego.v1

deny contains msg if {
	some rc in input.plan.resource_changes
	rc.type == "terraform_data"
	msg := sprintf("%s: terraform_data is not allowed here (workspace %s)", [rc.address, input.run.workspace.name])
}
