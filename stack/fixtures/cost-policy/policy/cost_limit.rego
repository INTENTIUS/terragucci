# Mandatory in policies.hcl: a root, or a wave, that adds more than 15.00 a month.
package terraform.policies.cost_limit

import rego.v1

deny contains msg if {
	to_number(input.run.cost_estimate.delta_monthly_cost) > 15
	msg := sprintf("%s adds %s %s a month, over 15.00", [input.run.workspace.name, input.run.cost_estimate.delta_monthly_cost, input.cost.currency])
}

deny contains msg if {
	input.cost.wave.monthly_delta > 15
	msg := sprintf("wave %d adds %v %s a month, over 15.00", [input.cost.wave.number, input.cost.wave.monthly_delta, input.cost.currency])
}
