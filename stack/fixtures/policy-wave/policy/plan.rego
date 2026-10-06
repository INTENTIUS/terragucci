# The plan as input. The deny rule has a suffix, so the claim shows both
# engines counting deny_* as conftest does; the warn rule fails nothing.
package main

import rego.v1

deny_terraform_data contains msg if {
	some rc in input.resource_changes
	rc.type == "terraform_data"
	msg := sprintf("%s: terraform_data is not allowed here", [rc.address])
}

warn contains msg if {
	some rc in input.resource_changes
	rc.change.actions[_] == "create"
	msg := sprintf("%s: a new resource, check its owner tag", [rc.address])
}
