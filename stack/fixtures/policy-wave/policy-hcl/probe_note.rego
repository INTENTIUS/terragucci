# Advisory in policies.hcl: its message is a warning that fails nothing.
package terraform.policies.probe_note

import rego.v1

deny contains msg if {
	some rc in input.plan.resource_changes
	rc.change.actions[_] == "create"
	msg := sprintf("%s: a new resource, check its owner tag", [rc.address])
}
