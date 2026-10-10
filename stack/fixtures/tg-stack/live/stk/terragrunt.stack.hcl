# Two units generated from the catalog: top reads base's output, so base goes
# out first. Each takes its rev from the values here.

unit "base" {
  source = "${get_repo_root()}/catalog/units/base"
  path   = "base"

  values = {
    rev = "1"
  }
}

unit "top" {
  source = "${get_repo_root()}/catalog/units/top"
  path   = "top"

  values = {
    rev = "1"
  }
}
