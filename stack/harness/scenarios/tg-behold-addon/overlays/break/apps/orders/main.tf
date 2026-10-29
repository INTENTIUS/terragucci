# BREAK (tg-behold-addon): behold's checkout holds orders as a plain root, with
# no module "app" call, so its apps read lists no app orders and the form's
# add-on request answers 422 not-an-app.
resource "terraform_data" "orders" {
  input = "hs-tgba-orders"
}
