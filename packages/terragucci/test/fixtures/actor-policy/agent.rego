package main

import rego.v1

changed := [rc |
  some rc in input.resource_changes
  rc.change.actions != ["no-op"]
  rc.change.actions != ["read"]
]

small if {
  count(changed) <= 5
  every rc in changed { rc.change.actions in [["create"], ["update"]] }
}

allow_unattended contains msg if {
  input.actor.kind == "agent"
  small
  msg := sprintf("%s made a small change", [input.actor.principal])
}

hold contains msg if {
  input.actor.kind == "agent"
  not small
  msg := sprintf("%s proposed %d changes, or a delete or replacement; a person approves it", [input.actor.principal, count(changed)])
}
