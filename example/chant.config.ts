// Written by terragucci init: each root is a terraform.roots entry, so chant's terraform-apply step can plan and apply it.
// Run terragucci init again after adding or moving a root.
export default {
  "terraform": {
    "roots": {
      "envs/dev/email": {
        "dir": "envs/dev/email"
      },
      "envs/dev/orders": {
        "dir": "envs/dev/orders"
      },
      "envs/dev/payments": {
        "dir": "envs/dev/payments"
      },
      "envs/dev/platform": {
        "dir": "envs/dev/platform"
      },
      "envs/dev/search": {
        "dir": "envs/dev/search"
      },
      "envs/prod/email": {
        "dir": "envs/prod/email"
      },
      "envs/prod/orders": {
        "dir": "envs/prod/orders"
      },
      "envs/prod/payments": {
        "dir": "envs/prod/payments"
      },
      "envs/prod/platform": {
        "dir": "envs/prod/platform"
      },
      "envs/prod/search": {
        "dir": "envs/prod/search"
      },
      "envs/staging/email": {
        "dir": "envs/staging/email"
      },
      "envs/staging/orders": {
        "dir": "envs/staging/orders"
      },
      "envs/staging/payments": {
        "dir": "envs/staging/payments"
      },
      "envs/staging/platform": {
        "dir": "envs/staging/platform"
      },
      "envs/staging/search": {
        "dir": "envs/staging/search"
      }
    },
    "binary": "tofu"
  }
};
