# Mandatory in policies.hcl: its message denies the root.
package terraform.policies.no_terraform_data

import rego.v1

deny contains msg if {
	some rc in input.plan.resource_changes
	rc.type == "terraform_data"
	msg := sprintf("%s: terraform_data is not allowed here", [rc.address])
}
