stack {
  name = "network"
  id   = "network"
}

output "name" {
  backend = "default"
  value   = "net-${terraform_data.this.input}"
}
