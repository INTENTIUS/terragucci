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
        "policy": "never"
      }
    }
  ],
  "defaults": {
    "op": "tf-apply"
  },
  "release": {
    "cut": false,
    "bin": [
      "terragucci"
    ]
  }
});
