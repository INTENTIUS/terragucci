# The Terramate fixture: three stacks whose order is Terramate's own.
# db runs before app (before), app after every stack tagged net (after), so
# init cuts two waves: db and network, then app. State is in floci's S3,
# under the prefix each claim fills in (@PREFIX@ in each main.tf).
terramate {
  config {
  }
}

globals {
  owner = "smoke"
}

generate_hcl "_terramate_generated_owner.tf" {
  content {
    locals {
      owner = global.owner
      stack = terramate.stack.name
    }
  }
}
