# The outputs-sharing fixture: app reads network's name through an input
# block, with no after, so the input alone puts app in the wave after
# network. State is in floci's S3 under @PREFIX@.
terramate {
  config {
    experiments = ["outputs-sharing"]
  }
}

sharing_backend "default" {
  type     = terraform
  command  = ["terraform", "output", "-json"]
  filename = "_terramate_generated_sharing.tf"
}
