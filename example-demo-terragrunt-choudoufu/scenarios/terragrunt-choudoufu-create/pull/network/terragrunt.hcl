include "root" {
  path = find_in_parent_folders("root.hcl")
}

inputs = {
  vpc_cidr        = "10.0.0.0/16"
  subnet_a_cidr   = "10.0.1.0/24"
  subnet_b_cidr   = "10.0.2.0/24"
  http_proxy_port = 8080
}
