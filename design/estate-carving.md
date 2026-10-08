# Estate carving (design)

Status: design for review. Nothing here is built, and no code starts until the user has reviewed this file. The site says nothing about carving.

Carving splits one large root (or Terragrunt unit) into several smaller ones without destroying or recreating anything in the cloud. Every stage runs as a job in the customer's CI or on a laptop, reads and writes only the customer's git and bucket, and needs no service of ours. Applying the split is the customer's own pipeline: a pull request, its plans, its gates and its approvals, the same as any other change.

| Stage | Command | Reads | Writes | Applies anything |
|---|---|---|---|---|
| 1. Survey | `terragucci carve survey` | each root's HCL, its state (read only), the reports in the bucket | `carve/survey.json` and a page in the bucket | no |
| 2. Propose | `terragucci carve propose carve.yml` | a carve map, the source root, its state | a branch and a pull request | no |
| 3. Verify | `stage tf-plan` with the carve check | the pull request's plans | the plan note and the report | no |
| 4. Migrate | the pull request's own waves, behind gates | the approved plans | state, through the roots' own backends | yes, once a person approves each wave |

## Stage 1: survey

The survey answers "which root is worth splitting, and along which line". It runs read-only in one CI job (a manual job beside drift) or locally with the same credentials the plan job has.

| Measure, per root | From |
|---|---|
| resources and data sources | `show -json` of the state; with choudoufu, the `live-check -json` roster |
| plan time, median of the last N plans | the `terragucci.report/v1` documents already in the bucket (`plan_seconds`, provider start-up, lock waits) |
| blast radius | how many other roots read this one: `terraform_remote_state` data sources and Terragrunt `dependency` blocks that point at it |
| providers and resource types | the state and the HCL |
| candidate slices | connected components of the reference graph inside the root, with top-level module calls kept whole |

A slice is a set of top-level blocks (resources, data sources, module calls) whose references stay inside the set, apart from a few named cuts. The survey ranks candidate slices by plan time saved and by cuts needed, and writes a suggested `carve.yml` that a person edits.

The same measures feed a new rollout tip, `terragucci-big-root`, next to `terragucci-many-roots` in `packages/terragucci/src/tips/index.ts`: a root over a resource count or a median plan time gets the tip in its report, with a pointer to the survey. Like every tip it is advisory and outside every digest.

## Stage 2: propose

`carve propose` reads a carve map and opens one pull request through the forge code `respond` already uses. It never applies, never touches state and never runs `chant approve`.

```yaml
# carve.yml
source: envs/prod/orders
into:
  envs/prod/orders-queues:
    blocks: ["aws_sqs_queue.jobs", "aws_sqs_queue.dead_letter"]
```

| The pull request holds | Detail |
|---|---|
| a new root (or unit) per destination | the moved blocks, copied as written; the source's `terraform` block, backend with a new key, providers and the variables the blocks read |
| `import` blocks in each destination | one per moved instance, with the ID read from the source's state; `for_each` instances get one block per key |
| `removed` blocks in the source | `lifecycle { destroy = false }` for every moved block, so the source forgets and destroys nothing |
| wiring for each cut reference | the side that keeps the referenced block gains an `output`; the other side reads it with `terraform_remote_state`, as the example's service roots read `platform`, or with a `dependency` block in a Terragrunt repo |
| the apply order | `layers` in `terragucci.yml` (or the `dependency` blocks) so the side that is read applies first |
| `MIGRATION.md` | the slices, every cut, the wave order, the window between waves and how to back out |

The carve unit is a top-level block. Moving part of a module call's resources is refused: the module is split first, as its own change. Propose also refuses a map whose cuts point both ways between two roots, since that makes a cycle no apply order can satisfy.

## Stage 3: verify

Verify is a check inside the plan stage, switched on when the pull request carries a `carve/` record from propose. It reads the plan JSON the job already saves and the report's named actions (`forget` and `import` are already in `NamedAction`).

| Root | Allowed in its plan | Anything else |
|---|---|---|
| source | `forget` for exactly the moved addresses; new outputs | fails `tf-plan`, naming the address and its action |
| each destination | `import` for exactly the moved addresses, each with no attribute change; reads | fails `tf-plan` |
| every root that reads a cut | no change | fails `tf-plan` |

The check also compares the two lists: every address the source forgets is imported by exactly one destination, and nothing is imported that the source does not forget. A carve that passes verify is a pure move: the cloud sees no call that changes a resource.

## Stage 4: person-run migration

The migration is the pull request's own apply, in two gated waves, with the gates of the repo's approval mode (`ledger`, `pr-review` or `sealed`). Each approval binds its wave's plan digest, so a plan that moved after approval applies nothing.

| Step | What runs | Who |
|---|---|---|
| 1 | a state backup of the source and each destination (`state pull`), written to the bucket under the run's key | the wave's job, before it applies |
| 2 | wave 1: the side that is read (the source when moved blocks read what stays, the destination when the reverse) | applies once a person approves its digest |
| 3 | wave 2: the other side | applies once a person approves its digest |
| 4 | a plan of every root the carve touched, which must show no changes | the job after wave 2 |

Between the waves the resources are either in no state (source first: orphaned, nothing destroys them) or in two (destination first: double-owned). `MIGRATION.md` names which. The roots on both sides stay locked from the first plan until wave 2 has applied, so no other pull request plans or applies them in the window. That lock is `locks: plan` (#399); until it exists the migration needs `apply.when: pull-request` and its apply-time locks, which Terragrunt repos get with #400.

Backing out: before wave 2, revert the pull request and re-plan; the backup restores a state that a failed wave left half written. After wave 2, carving the slice back is another carve.

## choudoufu slicing as an input

choudoufu already does the hardest part for its own estates and gives stock users read-only inputs.

| choudoufu piece | How carving uses it |
|---|---|
| `live-mv -from-estate` | carving a choudoufu estate needs no `import` and no `removed`: propose moves the blocks and the migration wave runs `live-mv -from-estate` per resource in the destination, a tag write with choudoufu's own refusals (third-party owner, a move that already ran). choudoufu's `carve-by-retag` claim proves the move; terragucci calls `live-mv` nowhere today. |
| `live-check -json` | the survey's roster with no cloud access: every instance's address, type and rung, and every cross-estate reference a data source's marker filters make visible |
| `live-import` without `-approve` | an optional preflight for a stock root: lists what is in the cloud and not in the state, so a carve does not start from a state that already misses resources |

## Claims that would prove each stage

Each claim runs on the Forgejo stack against `example/`, with a scenario patch that carves `aws_sqs_queue.jobs` and `aws_sqs_queue.dead_letter` out of a service root.

| Claim | Says | BREAK |
|---|---|---|
| `carve-survey` | the survey lists every root with its resources, median plan time and readers, and suggests a slice whose references stay inside it | the slice suggestion ignores references, and the claim sees a slice that cuts an unnamed reference |
| `big-root-tip` | a root over the resource threshold gets the `terragucci-big-root` tip in its report, and a small root does not | the threshold check is removed and the small root gets the tip |
| `carve-propose` | the pull request holds the new root, an import per moved instance, a removed block per moved block, the output and remote state for the cut, and `MIGRATION.md`, and nothing is applied | propose drops one import block, and the claim names the instance with no import |
| `carve-verify` | the source plans only forgets and the destination only imports, and `tf-plan` passes | the patch changes one attribute of a moved queue, and `tf-plan` fails naming its address |
| `carve-migrate` | wave 1 waits for its approval, then wave 2 waits for its own, a backup of each state is in the bucket, and every touched root then plans no changes | wave 2 is approved without wave 1, and the claim sees it refused |
| `carve-lock` | a second pull request that plans a carved root during the window is answered as locked, naming the carve | the lock is skipped and the second plan runs |
| `tg-carve` | the same carve in `example-terragrunt/`, wired with a `dependency` block | the `dependency` block is left out, and verify fails on the unresolved reference |
| `cdf-carve` | with `binary: choudoufu` the survey reads the roster from `live-check -json`, and the migration runs `live-mv -from-estate`, after which both estates plan clean | the retag is skipped, and both plans show the resource owned twice |

## Sizes

| Piece | Size | Mostly |
|---|---|---|
| survey and `terragucci-big-root` | M, about 600 lines and 3 days | reference graph over parsed HCL, reading reports from the bucket |
| propose | L, about 1,500 lines and 8 days | writing HCL by block ranges, import IDs per resource type, cut wiring, Terragrunt units |
| verify | S, about 300 lines and 2 days | a check over the plan JSON and named actions the report already builds |
| migration | M, about 500 lines and 4 days | state backup step, wave order from the carve record, the lock across waves |
| choudoufu path | M, about 400 lines and 3 days | the roster reader and a `live-mv` step |
| claims | M, 8 claims with BREAKs, about 5 days | scenario patches for both examples |

Total about 25 days. Survey and verify are useful alone and could ship first; propose is the risky piece.

## Risks

| Risk | Where it bites | Answer in this design |
|---|---|---|
| orphaned resource | source forgot it, destination never imported it | verify compares the two lists; wave 2 re-runs from the backup |
| double-owned resource | both states hold it after wave 1 | the lock across waves; wave 2 forgets it; verify refuses a second importer |
| a resource type with no import ID | `import` cannot name it | propose refuses that block by type and names it |
| `for_each` and `count` keys | an import per key, and keys that come from a variable the source sets | propose writes one import per instance from state and refuses keys it cannot resolve statically |
| secrets moving with state | the destination's state now holds the moved resources' sensitive values | `MIGRATION.md` lists the moved sensitive attributes; the destination's backend key needs the same access policy |
| cut references | an output the source never had, a remote state read that couples roots | outputs and `terraform_remote_state` follow the example's own pattern; a two-way cut is refused |
| locking both sides | another change lands on either root mid-migration | `locks: plan` from the first plan to wave 2 |
| binary versions | `removed` blocks and `import` blocks with `for_each` need Terraform 1.7 or OpenTofu 1.7 | propose reads the root's `required_version` and refuses below 1.7 |
| provider aliases and `moved` history | blocks that use an aliased provider, or old `moved` blocks in the source | propose copies the provider blocks the moved blocks use and keeps the source's `moved` blocks where they are |
| choudoufu stamped tags (untested) | an AWS resource whose `tags` argument is set may strip the ownership tags choudoufu stamps, unless the provider has `ignore_tags` | a `cdf-carve` BREAK that sets `tags` without `ignore_tags` before any choudoufu carve is advertised |

## Questions for the review

| Question | This design's answer |
|---|---|
| Is the carve unit a top-level block? | yes; module internals are split first, as their own change |
| Does propose write the new roots, or only the plan of them? | it writes them, in a pull request a person edits before merging |
| Cut wiring for plain Terraform | `terraform_remote_state`, as the example does; data source lookups are the alternative |
| Wave order | the side that is read applies first |
| Ship order | survey and tip, then verify, then propose and migration |
