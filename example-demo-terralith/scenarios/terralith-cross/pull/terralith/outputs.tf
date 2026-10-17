# A setting every team reads: each team root's log group takes its retention
# from here, through data.terraform_estate_outputs.
output "log_retention_days" {
  value = 14
}
