# A policy the pull request adds. Policy is read at the base, so it plans nothing.
package main

import rego.v1

deny contains msg if {
	some rc in input.resource_changes
	rc.type == "terraform_data"
	msg := sprintf("%s: terraform_data is not allowed here", [rc.address])
}
