# app: reads network's http_proxy_port and listens ten below it. edge reads
# app's output.

terraform {
  backend "s3" {
    bucket         = "demo-terraform-state"
    key            = "app.tfstate"
    region         = "us-east-1"
    use_lockfile   = true
    use_path_style = true
  }
}

data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket         = "demo-terraform-state"
    key            = "network.tfstate"
    region         = "us-east-1"
    use_path_style = true
  }
}

resource "terraform_data" "listener_port" {
  input = data.terraform_remote_state.network.outputs.http_proxy_port - 10
}

output "listener_port" {
  value = terraform_data.listener_port.input
}

# A migration that runs once, when it is created. It exits 1 while the object
# demo-control/app-migration-fails exists in floci: the demo's driver sets it
# before the cycle and deletes it before the re-run.
resource "terraform_data" "migration" {
  input      = terraform_data.listener_port.input
  depends_on = [terraform_data.listener_port]

  provisioner "local-exec" {
    interpreter = ["node", "-e"]
    command     = <<-EOT
      const url = (process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL) + "/demo-control/app-migration-fails";
      fetch(url).then(
        (r) => { if (r.ok) { console.error("the migration fails while " + url + " exists"); process.exit(1); } console.log("the migration ran"); },
        (e) => { console.error("could not reach " + url + ": " + e.message); process.exit(1); },
      );
    EOT
  }
}
