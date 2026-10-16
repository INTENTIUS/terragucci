# app's database schema: the SQL Yodeler project in schema/, applied to the
# demo's Postgres. One terraform_data per migration in schema/migrations.
# Creating one runs SQL Yodeler's wave for dev, the command its own apply job
# runs. It applies every pending migration, records each in its history table
# (yodeler.history) and exits 1 when one fails, which fails app's wave. Its
# first try comes after app's port, so the port lands either way.
#
# A failed create leaves its migration tainted. The next run replaces it, and
# gate: on-destructive holds that wave for an approval before SQL Yodeler runs
# again. The job image (terragucci.yml) has SQL Yodeler under /opt/yodel.
resource "terraform_data" "migration" {
  for_each   = toset([for f in fileset("${path.module}/schema/migrations", "*/migration.json") : dirname(f)])
  input      = each.key
  depends_on = [terraform_data.listener_port]

  provisioner "local-exec" {
    working_dir = "${path.module}/schema"
    environment = {
      DEV_POSTGRES_URL             = "postgres://demo-postgres:5432/demo"
      DEV_POSTGRES_WRITER_USER     = "demo_writer"
      DEV_POSTGRES_WRITER_PASSWORD = ""
      DEV_POSTGRES_READER_USER     = "demo_reader"
      DEV_POSTGRES_READER_PASSWORD = ""
      YODEL_CREDENTIALS            = "writer:dev"
    }
    command = <<-EOT
      set -e
      export PATH="/opt/yodel/node_modules/.bin:$PATH"
      ln -sfn /opt/yodel/node_modules node_modules
      echo "SQL Yodeler: chant run wave --spec yodel-waves.json --wave 1 runs yodel apply dev --wave-plan, then yodel apply dev --wave-apply"
      chant run wave --spec yodel-waves.json --wave 1
    EOT
  }
}
