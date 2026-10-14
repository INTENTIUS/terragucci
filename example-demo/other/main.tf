# other: reads no root and no root reads it, so no scenario plans it.

terraform {
  backend "s3" {
    bucket         = "demo-terraform-state"
    key            = "other.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

resource "terraform_data" "backup_schedule" {
  input = "0 3 * * *"
}

output "backup_schedule" {
  value = terraform_data.backup_schedule.input
}
