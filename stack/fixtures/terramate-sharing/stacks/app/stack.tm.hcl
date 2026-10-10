stack {
  name = "app"
  id   = "app"
}

input "net_name" {
  backend       = "default"
  from_stack_id = "network"
  value         = outputs.name.value
  mock          = "mocked"
}
