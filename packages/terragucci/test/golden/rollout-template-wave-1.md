Upgrade bucket to 1.3.0: orders (wave 1 of 2)

<!-- terragucci-rollout {"kind":"module","name":"acme/bucket/aws","from":"1.2.0","to":"1.3.0","wave":1,"waves":2,"roots":["apps/orders"]} -->
Wave 1 of 2 (canaries): upgrade the apps built from acme/bucket/aws from 1.2.0 to 1.3.0.

This pull request moves the template's pin for these apps and changes no other file:

- `apps/orders` (orders)

Changes to acme/bucket/aws after 1.2.0, up to 1.3.0, from the release catalog:

1.3.0:

- feat(bucket): add lifecycle rules for old objects (a1b2c3d)
- fix: tag the bucket's replica too (b2c3d4e)

Wave 2 opens on a later run, once every pull request of this wave has merged and its roots have applied.
