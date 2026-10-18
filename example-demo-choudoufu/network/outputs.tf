# A value the network estate chooses and every service reads through
# data "terraform_estate_outputs": how long a service keeps its logs. A value
# a live resource holds, such as the VPC's id, is read from that resource.

output "log_retention_days" {
  value = 14
}
