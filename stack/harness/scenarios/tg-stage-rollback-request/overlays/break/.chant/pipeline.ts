// Written by terragucci from terragucci.yml. Change the config and run `terragucci ci`;
// `terragucci ci --check` fails while this file differs from what the config writes.
import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  "name": "tf-apply",
  "stages": [
    {
      "name": "dev",
      "waves": [
        {
          "name": "wave-1",
          "runs": [
            {
              "target": "envs/dev/net"
            }
          ]
        }
      ],
      "gate": {
        "policy": "never"
      }
    },
    {
      "name": "staging",
      "waves": [
        {
          "name": "wave-1",
          "runs": [
            {
              "target": "envs/staging/net"
            }
          ]
        }
      ],
      "gate": {
        "policy": "never"
      },
      "soak": {
        "duration": "0",
        "checks": [
          {
            "kind": "command",
            "command": [
              "sh",
              "-c",
              "test ! -f soak-broken"
            ]
          }
        ]
      }
    },
    {
      "name": "prod",
      "waves": [
        {
          "name": "wave-1",
          "runs": [
            {
              "target": "envs/prod/net"
            }
          ]
        }
      ],
      "gate": {
        "policy": "always"
      }
    }
  ],
  "defaults": {
    "op": "tf-apply",
    "step": {
      "kind": "terraform-apply",
      "root": "{target}",
      "dir": "{target}"
    }
  },
  "release": {
    "cut": false,
    "bin": [
      "terragucci"
    ]
  }
});
