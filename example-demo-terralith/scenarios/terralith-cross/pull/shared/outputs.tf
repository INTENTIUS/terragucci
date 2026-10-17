# A setting every team reads: the log groups the shared root keeps take it
# from the local, and each carved team's root from the output, through
# data.terraform_estate_outputs.
locals {
  log_retention_days = 14
}

output "log_retention_days" {
  value = local.log_retention_days
}
