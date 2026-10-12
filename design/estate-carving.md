# Estate carving (design)

Status: approved 2026-10-07; revised 2026-10-12 to move resources with the shipped state migration (migration files and the `tf-migrate` gate) in place of `import` and `removed` blocks applied in two waves. Nothing here is built yet. The site says nothing about carving.

Carving splits one large root (or Terragrunt unit) into several smaller ones without destroying or recreating anything in the cloud. Every stage runs as a job in the customer's CI or on a laptop, reads and writes only the customer's git and bucket, and needs no service of ours. Applying the split is the customer's own pipeline: a pull request, its plans, the migration's gate and its approval, the same as any other state migration.

| Stage | Command | Reads | Writes | Applies anything |
|---|---|---|---|---|
| 1. Survey | `terragucci carve survey` | each root's HCL, its state (read only), the reports in the bucket | `carve/survey.json` and a page in the bucket | no |
| 2. Propose | `terragucci carve propose carve.yml` | a carve map and the source root's HCL | a branch and a pull request holding the new roots, the wiring and a migration file | no |
| 3. Verify | `stage tf-plan`: the migration's proof plus the carve check | the pull request's plans and the migration's proof | the plan note and the report | no |
| 4. Migrate | wave 1 of `stage tf-apply`, held on the `tf-migrate` gate | the approved migration digest | each root's state, under its lock, in one step | yes, once a person approves the digest |

## Stage 1: survey

The survey answers "which root is worth splitting, and along which line". It runs read-only in one CI job (a manual job beside drift) or locally with the same credentials the plan job has.

| Measure, per root | From |
|---|---|
| resources and data sources | `show -json` of the state; with choudoufu, the `live-check -json` roster |
| plan time, median of the last N plans | the `terragucci.report/v1` documents already in the bucket (`plan_seconds`, provider start-up, lock waits) |
| blast radius inside the root | chant's Terraform graph (`TfGraph`, which `chant carve advise` builds from the HCL): how far a change to each block reaches, from the reverse index and transitive reachability of INTENTIUS/chant#2325 and the per-block radius of INTENTIUS/chant#2326 |
| blast radius across roots | how many other roots read this one: `terraform_remote_state` data sources and Terragrunt `dependency` blocks that point at it |
| providers and resource types | the state and the HCL |
| candidate slices | reference-closed sets over chant's graph, with each named cut and its direction (INTENTIUS/chant#3909); a module call is one node, so it stays whole |

A slice is a set of top-level blocks (resources and module calls) whose references stay inside the set, apart from a few named cuts that all run one way. Data sources are not nodes in chant's graph; a slice copies each data source its blocks read. The survey ranks candidate slices by plan time saved and by cuts needed, and writes a suggested `carve.yml` that a person edits.

The split of work follows chant's boundary. chant computes over the graph: components, reachability, cuts and closures, with folds contracted. terragucci owns the carve product: the plan times, the ranking, `carve.yml`, the wiring, the migration file and the pull request. INTENTIUS/chant#2325 is no longer blocked (its fixture, INTENTIUS/chant#2323, is closed); #2326 and #3909 build on it.

The same measures feed a new rollout tip, `terragucci-big-root`, next to `terragucci-many-roots` in `packages/terragucci/src/tips/index.ts`: a root over a resource count or a median plan time gets the tip in its report, with a pointer to the survey. Like every tip it is advisory and outside every digest.

## Stage 2: propose

`carve propose` reads a carve map and opens one pull request through chant's pr-forge, as `respond` does. It never applies, never touches state and never approves anything.

```yaml
# carve.yml
source: envs/prod/orders
into:
  envs/prod/orders-queues:
    blocks: ["aws_sqs_queue.jobs", "aws_sqs_queue.dead_letter"]
```

| The pull request holds | Detail |
|---|---|
| a new root (or unit) per destination | the moved blocks, cut from the source and copied as written; the source's `terraform` block with a new backend key, the providers and the variables the blocks read |
| a migration file, `migrations/carve-<name>.yml` | one `moves` entry per destination, naming each moved block's address; the shipped migration moves every instance of each address, `for_each` and `count` keys included |
| wiring for each cut reference | the side that is read gains an `output`, and the other side reads it with `terraform_remote_state`, as the example's service roots read `platform`, or with a `dependency` block in a Terragrunt repo |
| the apply order | `layers` in `terragucci.yml` (or the `dependency` blocks) so the side that is read applies first in later changes |
| a carve record, `carve/<name>.json` | the slices, every cut and its direction, and the migration's name, which verify reads |
| the pull request's description | the slices, every cut, the moved sensitive attributes and how to back out |

The migration moves resources, not outputs, and its proof plans each root against its new state, so a cut read through an output needs that output in the read side's state before the carve's plan runs. When the read side is the source, propose opens the new outputs as a first pull request that applies like any change, and the carve pull request follows it. When the read side is a new root, which has no state until the migration writes one, propose wires the cut with a data source lookup of the moved resource instead, and refuses a type that has no data source.

The carve unit is a top-level block. Moving part of a module call's resources is refused: the module is split first, as its own change. Propose also refuses a map whose cuts point both ways between two roots, since that makes a cycle no apply order can satisfy, and a root whose backend the migration does not write (a `cloud` block, or an `s3` backend without `use_lockfile`). Every destination is in the source's repo; carving into another repo waits on cross-estate work (#753).

## Stage 3: verify

Most of verify ships today. The plan job proves each migration in the change: it builds each affected root's new state in the job, plans every root against it, requires no resource change and prints the digest. A moved block left out of the migration file shows up there as a destroy in the source or a create in a destination, and a moved block whose code changed shows up as an update; either fails the job, naming the address.

The carve check adds what the proof cannot see, switched on when the pull request carries a carve record:

| Check | Anything else |
|---|---|
| the migration's addresses equal the blocks the carve record moves, each in exactly one destination | fails `tf-plan`, naming the address |
| every root that reads a cut, other than the source and destinations, plans no change | fails `tf-plan`, naming the root and its change |
| the plan note marks the source's destroys and the destinations' creates, which the roots' own plans show before the move is written, as the migration's move | a destroy or create of an address the migration does not move fails `tf-plan` |

A carve that passes verify is a pure move: the cloud sees no call that changes a resource.

## Stage 4: person-run migration

The migration is terragucci's shipped state migration. Nothing in this stage is new code.

| Step | What runs | Who |
|---|---|---|
| 1 | after the merge, wave 1 of `stage tf-apply` runs through `chant run wave`, proves the migration again, and holds on its own gate, `tf-migrate <name>`, through chant's `CHANT_HOLD`; every later wave waits on wave 1 | the apply job |
| 2 | `terragucci approve <name> --plan <digest>` approves that digest and nothing else, with `--sign` under `approval: sealed`; a pull request review does not approve a migration under any approval mode | a person |
| 3 | wave 1 again, started by `terragucci approve` or the resume job: it takes each state's lock, refuses with exit 4 if a state moved since the plan, writes the new states (each destination first), plans every root again and requires no change | the apply job |
| 4 | the record: each root's version before and after in `_gates/tf-migrate/done.jsonl` on `chant/lifecycle`, in the report and in the audit trail | the apply job |

A carve into several destinations is one migration file with a move per destination. A change that carries two migrations applies both in one job (#909). Because the write is one step under every state's lock, there is no window in which a resource is in no state, and no lock to hold across waves. A write that stops half way leaves a resource in both states, never in neither.

Backing out: before the merge, close the pull request. After the migration applied, `terragucci migrate revert carve-<name>` writes a revert migration from the record, which goes through the same proof and approval with the reverted code; it needs backends that keep versions. Carving the slice back later is another carve.

## choudoufu slicing as an input

choudoufu already does the hardest part for its own estates and gives stock users read-only inputs.

| choudoufu piece | How carving uses it |
|---|---|
| `live-mv -from-estate` | carving between two choudoufu estates writes the same migration file; the shipped migration proves the move with `live-mv -dry-run` and, once approved, runs `live-mv -from-estate` per resource in the destination, with choudoufu's own refusals (third-party owner, a move that already ran). A move from a root with a state into an estate is refused: the state is adopted first. |
| `live-check -json` | the survey's roster with no cloud access: every instance's address, type and rung, and every cross-estate reference a data source's marker filters make visible |
| `live-import` without `-approve` | an optional preflight for a stock root: lists what is in the cloud and not in the state, so a carve does not start from a state that already misses resources |

## Claims that would prove each stage

Each claim runs on the Forgejo stack against `example/`, with a scenario patch that carves `aws_sqs_queue.jobs` and `aws_sqs_queue.dead_letter` out of a service root. A person grants them with `just grant carve` (or `just grant carve/<part>`), and the granted names then run with `just claims carve/<part>...`.

| Claim | Says | BREAK |
|---|---|---|
| `carve/survey` | the survey lists every root with its resources, median plan time and readers, and suggests a slice whose references stay inside it apart from cuts it names | the slice suggestion ignores references, and the claim sees a slice that cuts an unnamed reference |
| `carve/big-root-tip` | a root over the resource threshold gets the `terragucci-big-root` tip in its report, and a small root does not | the threshold check is removed and the small root gets the tip |
| `carve/propose` | the pull request holds the new root, a migration file naming every moved block, the output and remote state for the cut, and the carve record, and nothing is applied | propose leaves one moved block out of the migration file, and the claim names the block with no move |
| `carve/verify` | the migration's proof passes, the carve check finds the migration's addresses equal to the moved blocks, and no reader of a cut plans a change | the patch changes one attribute of a moved queue, and `tf-plan` fails naming its address |
| `carve/migrate` | wave 1 holds on `tf-migrate carve-<name>` until its digest is approved, then every root the carve touched plans no changes and `done.jsonl` records each root's version before and after | the source's state is written after the approval, and wave 1 refuses with exit 4 naming the root |
| `carve/terragrunt` | the same carve in `example-terragrunt/`, wired with a `dependency` block | the `dependency` block is left out, and verify fails on the unresolved reference |
| `carve/choudoufu` | with `binary: choudoufu` the survey reads the roster from `live-check -json`, and the migration runs `live-mv -from-estate`, after which both estates plan clean | an AWS resource sets `tags` without `ignore_tags`, and the claim sees choudoufu's stamped tags stripped |

## Sizes

| Piece | Size | Mostly |
|---|---|---|
| survey and `terragucci-big-root` | S, about 400 lines and 2 days | reading chant's graph, its cuts and radius, and the reports in the bucket; the graph work itself is chant's (#2325, #2326, #3909) |
| propose | M, about 900 lines and 5 days | writing HCL by block ranges, the migration file, cut wiring and its ordering, Terragrunt units |
| verify | S, about 150 lines and 1 day | the address comparison and the readers' plans; the no-change proof ships today |
| migration | none | the shipped state migration; propose writes its file |
| choudoufu path | S, about 150 lines and 1 day | the roster reader; `live-mv` already runs through migration files |
| claims | M, 7 claims with BREAKs, about 4 days | scenario patches for both examples |

Total about 13 days, down from 25. Survey and verify are useful alone and could ship first; propose is the risky piece.

## Risks

| Risk | Where it bites | Answer in this design |
|---|---|---|
| a write that stops half way | the job stops between one state's write and the next | each destination is written first, so a resource is in both states and never in neither; the record names each version before, and `migrate revert` puts them back where versions are kept |
| a state written after the approval | another apply lands on the source or a destination before wave 1 writes | the digest binds each state's version; wave 1 refuses with exit 4, naming the root, and every later wave waits on wave 1 |
| backends that keep no versions | `pg`, `kubernetes`, `consul` and most `http` backends | the digest binds each state's contents; the migration cannot be reverted, and the pull request's description says so |
| secrets moving with state | the destination's state now holds the moved resources' sensitive values | the pull request's description lists the moved sensitive attributes; the destination's backend key needs the same access policy |
| cut references | an output the source never had, a remote state read that couples roots, an output the migration does not move | outputs and `terraform_remote_state` follow the example's own pattern, in a first pull request when the source is read; a data source lookup when a new root is read; a two-way cut is refused |
| provider aliases and `moved` history | blocks that use an aliased provider, or old `moved` blocks in the source | propose copies the provider blocks the moved blocks use and keeps the source's `moved` blocks where they are |
| chant's graph misses a reference | a reference the HCL parser cannot see | the migration's proof fails the plan on any change the move would cause, whatever the survey suggested |
| choudoufu stamped tags (untested) | an AWS resource whose `tags` argument is set may strip the ownership tags choudoufu stamps, unless the provider has `ignore_tags` | the `carve/choudoufu` BREAK, before any choudoufu carve is advertised |

## Questions for the review

Answered in the 2026-10-07 review; the wave order and wiring answers changed with the 2026-10-12 revision.

| Question | This design's answer |
|---|---|
| Is the carve unit a top-level block? | yes; module internals are split first, as their own change |
| Does propose write the new roots, or only the plan of them? | it writes them, with the migration file, in a pull request a person edits before merging |
| Cut wiring for plain Terraform | `terraform_remote_state`, as the example does, with the read side's outputs applied first; a data source lookup when the read side is a new root |
| Wave order | the migration writes every root in wave 1, under each state's lock, in one step; later waves apply in `layers` order |
| Ship order | survey and tip, then verify, then propose |
