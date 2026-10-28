# The add-on cache of the app orders, from the template acme/cache/aws. Written by chant from a template request; a rollout moves the version.

module "cache" {
  source  = "modules.test/acme/cache/aws"
  version = "0.3.0"

  subnet_ids = module.app.private_subnets
  node_type  = "cache.t4g.micro"
}
