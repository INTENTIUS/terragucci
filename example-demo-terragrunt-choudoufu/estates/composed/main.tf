# The composed root: one module call per estate, and nothing else. choudoufu
# plans and applies the three estates as one run. An estate keeps its own
# `live` block, provider blocks and variable defaults, so a call passes no
# arguments (choudoufu refuses one).
module "network" {
  source = "../network"
}

module "app" {
  source = "../app"
}

module "edge" {
  source = "../edge"
}
