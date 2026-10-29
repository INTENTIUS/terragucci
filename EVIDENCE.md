# Evidence

What terragucci checks, how, and the last result of each check. The docs site does not carry these results. This file is updated with each release.

It is generated: `npx tsx scripts/evidence.ts` rewrites it from the records the validation stack writes, and `npx tsx scripts/evidence.ts --check` fails when it is out of date.

## How a claim is verified

A claim is one sentence about the pipeline, such as "a merge request that changes one of two roots plans that root alone". Each claim runs twice on a local stack of CI, a forge and an AWS emulator:

1. As written, it must pass.
2. With its property broken on purpose (the BREAK run), it must fail. A claim whose BREAK run is caught is `proven`. A claim with no BREAK run only `passes`.

The records:

- `stack/evidence/smoke.json`: the claims run on Forgejo with OpenTofu, and the ones also run on GitLab, Terraform and choudoufu. Recorded 2026-10-08 at commit c51e358; each row carries the commit it ran at.
- `stack/evidence/validation.json`: the per-forge claims. Recorded aws 2026-10-04, forgejo 2026-10-07, github 2026-10-07, github.com 2026-10-10, gitlab 2026-10-09.
- `stack/evidence/claim-areas.json`: the feature area of each claim, and the forge or binary a claim's own config sets.

| Forge | What runs |
|---|---|
| Forgejo | a Forgejo server and its runner |
| GitHub | the generated workflow, run by `act` against a mock GitHub API |
| github.com | the published release's generated workflow on GitHub-hosted runners, in a public plan-only repo |
| GitLab | GitLab CE and its runner |

The Terraform and choudoufu results are the core claims run again on that binary in its CI image. They use `binary:` in each repo's `terragucci.yml`, on a copy of the repo written for the binary.

Run them with `just claims <name>`, `just claims-affected` and `just coverage-fill`; CONTRIBUTING.md has the details.

### Limits of the github.com claims

Every resource there is a `terraform_data`, so nothing needs a cloud account.

| Limit | What runs instead |
|---|---|
| no cloud role | `oidc/job` checks each job's token against GitHub's published keys, its repo, run, audience and role, and trades it with nothing; the trade with STS is proven on Forgejo |
| no bucket | `report/keys`, `report/oidc` and `estate/job` write to floci, the AWS emulator, run in the job beside a stand-in for STS |
| one GitHub account | the refusals of a commenter with no write access and of a pull request from a fork are proven on Forgejo |
| no model key | the agent comment and the refused-wave job run a stand-in agent |
| BREAK for the locking and report claims alone | the other github.com claims have no BREAK run, so they read `passes` |

## Claims by feature area

One row per claim. The result is the weakest of its runs. Where it runs lists every forge (and non-OpenTofu binary) the claim has a recorded run on.

### Plan and review

46 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `affected/atmos` | a pull request that changes one Atmos instance plans that instance and the instances whose dependencies.components name it, and no other | Forgejo | proven |
| `affected/cdktn` | with synth set a pull request that changes one CDK Terrain stack plans that stack alone, and the plan note says how many stacks were unchanged | Forgejo | proven |
| `affected/outside-roots` | a change outside every root plans the roots that read it: a shared var file TF_CLI_ARGS names plans the roots that read it, a file a symlink points at plans the root that links it, a version for envs/prod/** in terragucci.yml plans those roots only, a new synth command plans every root, and a policy, approval mode or step added at head plans nothing, since they are read at the base | Forgejo | proven |
| `affected/terragrunt` | only the units a change reaches are planned, including a file a module reads that Terragrunt misses | Forgejo | proven |
| `affected/terragrunt-dependents` | terragrunt.dependents: plan previews the dependents of a change provisional and outside every digest, and terragrunt.exclude leaves a unit out | Forgejo | proven |
| `affected/terragrunt-stack` | a pull request that changes one value in a terragrunt.stack.hcl plans only the unit that value feeds, says so, lists the unit that depends on it as waiting, and the report and note name the stack file | Forgejo | proven |
| `affected/terramate` | a pull request that changes one Terramate stack plans that stack and the stacks whose after or before put them after it, and no other | Forgejo | proven |
| `affected/tofu` | only the roots a change touches are planned | Forgejo, GitLab, github.com | passes |
| `check/atmos` | the check job of an Atmos repo runs atmos validate stacks before it writes the instances, and fails on a manifest Atmos refuses, with the error Atmos gives | Forgejo | proven |
| `check/choudoufu` | the generated workflow for a choudoufu estate fails a resource that live-check refuses and names it | Forgejo (choudoufu), GitHub (choudoufu), GitLab (choudoufu) | proven |
| `check/diagnostics` | tf-check fails with the cause in its log for a validate error, a failing policy test and a choudoufu live-check refusal | Forgejo | proven |
| `check/terragrunt` | tf-check fails an unformatted Terragrunt file and names it | Forgejo, GitHub, GitLab | proven |
| `check/terragrunt-stack` | the check job of a Terragrunt repo generates its explicit stack and validates the generated units, failing on a unit whose template reads a value the stack file does not feed it, and naming that unit | Forgejo | proven |
| `check/terramate` | the check job of a Terramate repo fails on stale generated code, naming the file terramate generate would change | Forgejo | proven |
| `check/tofu` | tf-check fails an unformatted root and names the file | Forgejo, GitHub, GitLab | proven |
| `comment/atlantis` | with atlantis_comments on, atlantis plan re-plans a pull request, and atlantis apply and an Atlantis-only flag are refused as the terragucci forms are | Forgejo | proven |
| `comment/dispatch` | a workflow_dispatch of the plan workflow with pr set re-plans that pull request: the replan job posts a new terragucci/plan status on its head and updates the same plan note, and Forgejo refuses the dispatch of a user with read access only | Forgejo | proven |
| `comment/not-affected` | a re-plan comment for a root the pull request does not reach is answered that it is not affected and plans nothing, and a re-plan whose forge call fails fails its job with the cause | Forgejo | proven |
| `comment/plan` | a Developer /terragucci plan note starts a merge request pipeline of the same head, whose plan job passes and updates the plan note | GitLab, github.com | passes |
| `comment/poll` | the comments schedule answers a Developer merge request note once across two polls, carrying its marker, and never a non-member note | GitLab | proven |
| `cost/estimate` | with cost set, the plan note of a pull request gives the monthly cost change of each root and the total, from the estimator run with the key the plan job gets from its secret | Forgejo | proven |
| `estate/local-plan` | terragucci plan run on a machine plans each root its glob names against the applied state: the changed root plans its one change, the others none, and the --json envelope lists them all with exit 0 | Forgejo | proven |
| `init/cdktn-synth` | with synth set to npx cdktn synth the pipeline synthesizes the CDK Terrain stacks before check, apply and tf-plan, and tf-plan plans the stack the change reaches | Forgejo | proven |
| `linked/backend-config` | a root whose backend block names no path, which init takes from the backend.hcl that TF_CLI_ARGS_init in terragucci.yml passes, is ordered before the root that reads its state, and the reader plans on its planned outputs | Forgejo | proven |
| `linked/cdktn` | a CDK Terrain stack that reads the state of another through a remote state data source plans in tf-plan on the planned outputs of that stack, read from its cdk.tf.json, unknown where unknown | Forgejo | proven |
| `linked/fresh` | on a fresh estate the plan job holds back a root whose upstream is unapplied, names it in the report, and stays green | Forgejo | proven |
| `linked/local` | two roots on the local backend, one reading the other through terraform_remote_state by the same path: terragucci orders them into two waves on its own, and the reader plans on the planned outputs of the writer | Forgejo | proven |
| `linked/plan` | a root that reads the state of another plans in tf-plan on the planned outputs of that root, unknown where unknown, and its wave is marked to plan again once the upstream applies | Forgejo | proven |
| `linked/terragrunt-mock` | a unit that reads a new upstream is planned on the planned outputs of that upstream, never on its mock_outputs | Forgejo | proven |
| `linked/terragrunt-preview` | a pull request previews the later layers of a Terragrunt change: a unit is planned on the planned outputs of its upstream, and one that reads a value known only once its upstream applies is named with that value and wave, never planned on a stand-in | Forgejo | proven |
| `note/blast` | a pull request that changes a queue gets a plan note whose blast radius lists, under the queue, its policy in the same root and the function and mapping that read its ARN in another root, and leaves out the log group that reads only another output | Forgejo | proven |
| `note/diff` | the plan note on Forgejo shows the diff of a group as the binary prints it, with the value before and after of the attribute that changes, and the whole plan of the root in a collapsed block | Forgejo | proven |
| `note/footer` | the plan note on a merge request ends with the terragucci footer, GitLab renders its taco image, and the image answers 200 with a PNG | GitLab, github.com | passes |
| `note/grouped` | one note groups many plans | Forgejo | proven |
| `note/mr-widget` | the Terraform widget of a merge request counts the creates, updates and deletes of the plan job report, a replacement as a create and a delete | GitLab | proven |
| `note/split` | a plan over the comment limit of the forge stays one note within the limit: the largest whole plan is left out and named in a Cut line that links its plan.txt, and the rest stays | Forgejo | proven |
| `report/highlight` | destroys and outliers are open, identical groups are folded | Forgejo | proven |
| `report/sensitive` | IAM, security group, KMS and DNS changes are open with their reasons, and an import and a forget are named, the forget not counted as a destroy | Forgejo | proven |
| `respond/fmt` | fmt on request commits to the pull request branch and nowhere else | Forgejo | proven |
| `respond/terragrunt-fmt` | in a Terragrunt repo the fmt job runs terragrunt hcl fmt after a branch fails its check and pushes the formatting commit to the branch, and nowhere else | Forgejo | proven |
| `respond/tips` | each tip becomes its own small pull request | Forgejo | proven |
| `steps/before-plan` | a step before plan writes a file the plan reads, read from terragucci.yml at base, and the plan note lists the step | Forgejo | proven |
| `tips/cdktn` | with synth set the tips job synthesizes the CDK Terrain stacks and opens the canary tip, and says the pin and lock file tips are left out | Forgejo | proven |
| `tips/moved` | a resource renamed on a branch plans as a destroy and a create, the plan report tips the moved block, respond tips opens a pull request into the branch that adds it, and once merged the plan moves the resource and destroys nothing | Forgejo | proven |
| `tips/terragrunt-mock` | a dependency whose mock_outputs can stand in for apply is named by a tip | Forgejo | proven |
| `tips/tofu` | tips are on by default and name their rule | Forgejo, GitLab, github.com | passes |

### Approve and apply

46 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `apply/branches` | with apply.branches mapping release to canary/*, a push to main applies the fleet roots behind the gate and never canary/one, and a push to release applies canary/one alone, waiting at the same gate until its wave is approved | Forgejo | proven |
| `apply/cdktn` | with synth set each apply wave synthesizes the CDK Terrain stacks and applies its stack behind the gate: dev once wave 1 is approved, prod once wave 2 is | Forgejo | proven |
| `apply/choudoufu` | the generated workflow for a choudoufu estate applies it on the default branch, and the bucket carries the estate marker | Forgejo (choudoufu), GitHub (choudoufu), GitLab (choudoufu) | proven |
| `apply/gitlab-parallelism` | roots on GitLab-managed state apply at most 3 at once, and the apply job says so | GitLab | proven |
| `apply/groups` | with environments prod and dev, each with its own roles, a wave holding a root of each is planned and gated by one job that holds no apply role, then applied by one job per environment, each carrying the apply role of its own environment alone, under one approval; on Forgejo both jobs present the same token subject, so the roles each job is handed are all that keeps them apart | Forgejo | proven |
| `apply/terragrunt` | the generated workflow for a Terragrunt repo applies both of its units on the default branch | Forgejo, GitHub, GitLab | proven |
| `apply/terragrunt-branches` | with apply.branches mapping release to live/canary/*, a push to main applies the fleet units behind the gate and never live/canary/one, and a push to release applies live/canary/one alone, waiting at the same gate until its wave is approved | Forgejo | proven |
| `apply/tofu` | a push to main applies the root, and the bucket exists afterwards | Forgejo, GitHub, GitLab | proven |
| `approval/at-base` | a merge that switches approval from sealed to ledger is judged by the sealed rule of the commit before it, and the next merge by ledger | Forgejo | proven |
| `approval/gate` | a merged destroy stops its wave with the approve command, and after a sealed chant approve the re-run applies it | github.com | passes |
| `approval/ledger` | with no approval key a wave counts an unsigned approval of its set digest, init declares no gate, and the waiting wave prints the approval command without --sign | Forgejo | proven |
| `approval/pr-review` | with approval pr-review, a Developer approval of the merge request lets the merge commit gated wave apply, and the job names the approver | GitLab | proven |
| `approval/pr-review-status` | with approval: pr-review terragucci/approval on the head of a pull request is pending while a wave waits, and success once a writer other than the author approves the head | Forgejo | proven |
| `approval/resume` | terragucci approve, given a forge token of the approver, resumes the waiting wave of a merged pull request, which applies with nothing else done | Forgejo | proven |
| `approval/resume-schedule` | with apply.resume set, a run of the resume workflow applies a waiting wave once an approval of its digest is on chant/lifecycle | Forgejo | proven |
| `approval/sealed` | under approval: sealed a wave counts only an approval sealed by a key the signers file lists | Forgejo | proven |
| `approval/sealed-migrate` | a repo whose chant.workspace.json lists the wave gates and whose config names no approval mode stays sealed, and the wave and config check say so | Forgejo | proven |
| `approval/signer-trust` | init --signer writes the signers line from git config user.signingkey, and an approval sealed with that key lets the wave apply | Forgejo | proven |
| `comment/apply` | a comment on a merged pull request re-runs its apply from the merge commit, applies a wave under approval: sealed only once its approval is sealed, and refuses an open pull request and a commenter with no write access | Forgejo, github.com | passes |
| `linked/atmos` | an Atmos instance whose stack reads an unapplied instance with !terraform.state is held back, never planned on a stand-in, and applies on the output of the upstream once it has applied | Forgejo | proven |
| `linked/gitlab-state` | a root that reads the GitLab-managed state of another through terraform_remote_state by its address applies in the wave after it, with its output | GitLab | proven |
| `linked/states` | after a pull request changes an output of wave 1, wave 2 plans again once wave 1 applied, shows the new value, and waits for an approval of that plan; the run view in the bucket shows where each wave stands | Forgejo | proven |
| `linked/terragrunt-preview-gate` | a Terragrunt wave whose plan differs from the preview of it in the pull request says so at its gate, naming what moved, before anyone approves | Forgejo | proven |
| `linked/terramate` | a Terramate stack whose input block reads an output of an unapplied stack is held back, never planned on the mock, and applies on the output of the upstream once it has applied | Forgejo | proven |
| `note/approve-command` | the plan note of a pull request gives the terragucci approve command with the digest its gated wave asks for after the merge, and terragucci approve in a checkout approves that wave with no digest copied | Forgejo, github.com | passes |
| `pr-apply/confirm` | with apply.when: pull-request the push of the merge commit runs confirm, which plans every root, posts terragucci/apply success and applies nothing | Forgejo | proven |
| `pr-apply/requires` | with apply.requires: [approved] an approved pull request behind the default branch applies from its head, the default requirements refuse it as not up to date, and a pull request that conflicts with the default branch is refused as not mergeable | Forgejo | proven |
| `pr-apply/tofu` | with apply.when: pull-request, a comment on an open and approved pull request applies its head in waves and then merges it with apply.merge: auto | Forgejo (Terraform), Forgejo (choudoufu), GitLab, github.com | passes |
| `pr-apply/token` | with apply.merge: auto and merge_token_env the merge is made with that token, so the merge commit starts its own run on main | github.com | passes |
| `refuse/approval-used` | once a wave applied under its approval, the next merge that moves its plans waits with the approve command for the new digest, and only an approval of plans that never applied refuses | Forgejo | proven |
| `refuse/approve-plan` | terragucci approve --plan with a digest the plans moved past approves nothing, exits 1 and names the digest waiting | Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `refuse/pr-review` | with approval: pr-review a wave whose plans changed between the review of the head and the merge applies nothing and prints the terragucci approve command for its new digest | Forgejo | proven |
| `refuse/tofu` | a wave whose plans changed after approval applies nothing | Forgejo | proven |
| `report/outcome` | stage tf-apply writes how its wave ended to TG_OUTCOME_JSON as terragucci.outcome/v1: waiting with its digest, mode and approve command, refused with the digest approved and the root that moved, and failed with the root | Forgejo | proven |
| `respond/refused` | a refused wave names each root whose plan moved and the attributes that moved | Forgejo | proven |
| `respond/triage` | a failed apply is triaged from the known-error table | Forgejo | proven |
| `steps/gate` | a step with on_failure approve that fails holds its wave at the gate under gate never, naming the step, with the approve command for its digest | Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `steps/stop` | a step before apply that exits 1 fails the wave job before anything applies | Forgejo | proven |
| `waves/after` | waves.after orders plain roots that read nothing of each other: network, database and app apply in three waves, and a pull request that changes network plans all three | Forgejo | proven |
| `waves/atmos` | init names one root per Atmos instance, <stack>/<component>, from atmos describe stacks, and cuts a wave per layer of dependencies.components: each dependent instance applies in the wave after its dependency, behind its own gate | Forgejo | proven |
| `waves/jobs` | with waves.jobs on GitLab a wave waits at one gate, then its share jobs apply their own roots under one approval, used once, and leave no lock behind | GitLab | proven |
| `waves/terragrunt` | the Terragrunt example boots in five waves, one job each: the dependency layers of the dev canary, then the layers of staging and prod, each with one run --all | Forgejo | proven |
| `waves/terragrunt-layers` | a Terragrunt repo of three units in a chain goes out in three waves, one job each, every wave waiting for an approval of its own set digest before it applies | Forgejo | proven |
| `waves/terragrunt-stack` | the units of an explicit stack are generated before discovery, cut into waves by their dependencies, and applied in order from a checkout that holds none of them | Forgejo | proven |
| `waves/terramate` | init takes the stacks of a Terramate repo as roots and cuts a wave per layer of their order: a stack after a tag or before another applies in the wave its order gives it, behind its own gate | Forgejo | proven |
| `waves/tofu` | each wave goes out only once approved | Forgejo (Terraform), Forgejo (choudoufu) | proven |

### Locks and safety

37 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `apply/check-job` | with environments prod and dev and the condition of the apply jobs widened by hand to any push, the apply job of each environment on a branch it does not apply from fails before it trades a token, naming the expected and the found ref, and on main passes its check and trades its token; Forgejo has no deployment environments and names no runner labels to a job, so the ref is what is checked here | Forgejo | proven |
| `apply/per-root` | a second push applies one root while the wave of the first push is still applying another: no apply job waits for another run, and the state lock of the backend keeps the applies of one root apart | Forgejo | proven |
| `apply/serial` | two pushes to main apply one after the other, and the commit carries one terragucci/apply status | Forgejo, Forgejo (Terraform), GitLab, github.com | proven |
| `apply/stand-down` | a wave of a push whose commit is no longer the tip of main stands down once the newer push has landed: it applies nothing, its terragucci/apply says superseded by a newer push, and the newer push applies the root | Forgejo | proven |
| `choudoufu/concurrency` | with binary: choudoufu two tf-apply waves of one estate, each adding a resource whose apply takes 60 seconds, finish both in under 90 seconds; two that change different resources reach their record writes together and both apply, with no lock wait and no lock object; and two that change one resource at once settle on one record: one lands, the other fails its conditional write naming the resource and overwrites nothing, and its re-plan shows the value that landed | Forgejo (choudoufu) | proven |
| `choudoufu/killed` | with binary: choudoufu while an approved tf-apply wave applies, its run view and progress.json show the resource whose apply returned done and the slow one after it in flight; killed then, the wave leaves a record for the first and none for the second, and the wave run again applies only the second under the same approval, with no new one | Forgejo (choudoufu) | proven |
| `choudoufu/rows-overlap` | with binary: choudoufu two pushes whose plans change different resources of one estate apply at the same time: each wave holds the resource it changes, both reach their record writes together, both apply, and no row is left held | Forgejo (choudoufu) | proven |
| `choudoufu/rows-takeover` | with binary: choudoufu a wave killed after its change landed, while it held the queue it changes, leaves its row held; the wave of the next push takes it over with nothing unlocked, and the re-read of its apply refuses the plan the killed run made stale before any call | Forgejo (choudoufu) | proven |
| `choudoufu/rows-wait` | with binary: choudoufu two tf-apply waves change the visibility timeout of one SQS queue on floci: the second waits for the first and makes no call while the call of the first is in flight, as the request log of the emulator shows, then plans again and applies its value | Forgejo (choudoufu) | proven |
| `linked/terragrunt-mock-trap` | a new upstream and its dependent merge together and apply in order, so no mock reaches real state | Forgejo | proven |
| `lock/apply` | with apply.when pull-request, a merge request applied on a note locks the roots it reaches: /terragucci apply on a second merge request that reaches one is refused with the root and the holder named, and applies once the first is unlocked with /terragucci unlock | GitLab, github.com | proven |
| `lock/atmos` | with apply.when: pull-request in an Atmos repo, a pull request applied on a comment locks the Atmos instances it reaches (every instance, for a change to a stack manifest), and a second pull request that changes one is refused with the instance and the holder named, its state left as the first applied it | Forgejo | proven |
| `lock/cdktn` | with synth and apply.when: pull-request, a pull request applied on a comment locks every CDK Terrain stack, since its change to the app can reach any, and a second pull request that changes a stack is refused with the stack and the holder named, its state left as the first applied it | Forgejo | proven |
| `lock/close-release` | with apply.when pull-request, closing a merge request releases the roots it locked: /terragucci lock on a second merge request then takes them | GitLab | proven |
| `lock/comment` | /terragucci lock on an open pull request locks the roots it reaches and applies nothing, and a second pull request that reaches one is refused with the root and the holder named | Forgejo, github.com | proven |
| `lock/comment-fmt` | with locks: plan a pull request whose check job formats it, with a push that starts no workflow, still has its lock answered on the formatted head | github.com | proven |
| `lock/plan` | with locks: plan a pull request locks the roots it reaches from its first plan, a second pull request that reaches one gets a failing terragucci/lock and a reply naming the root and the holder, and after /terragucci unlock its /terragucci plan takes the lock | Forgejo | proven |
| `lock/plan-fmt` | with locks: plan a pull request whose push the fmt job formats, with a push that starts no run, has its lock answered on the formatted head | Forgejo | proven |
| `lock/plan-none` | a pull request plan and a drift run plan a root while an apply holds its state lock, and neither waits for it | Forgejo | proven |
| `lock/plan-release` | with locks: plan the merge of a pull request releases the lock its first plan took | Forgejo | proven |
| `lock/terragrunt` | in a Terragrunt repo, a pull request that changes a unit whose dependencies block names a unit another open pull request applied is refused with the unit and the holder named | Forgejo | proven |
| `lock/terragrunt-fanout` | in a Terragrunt repo a change to root.hcl locks every unit and says why, and a Markdown-only change locks none | Forgejo | proven |
| `lock/wait-span` | with binary: terraform a tf-apply wave whose plan meets a state lock another Terraform plan holds waits for it under the default -lock-timeout terragucci adds, the root's plan time in the report covering the wait, and applies once the lock is released | Forgejo (Terraform) | proven |
| `note/sensitive` | a change to a sensitive variable and a sensitive output keeps both values out of the plan note, the report, the job log and every object in the reports bucket | Forgejo | proven |
| `note/stale` | a push to the default branch that changes a root an open pull request planned marks its plan note stale | Forgejo | proven |
| `pr-apply/guard` | with apply.when: pull-request a pull request that changes the pipeline file, or whose checks failed, is refused and applies nothing | Forgejo | proven |
| `pr-apply/stale` | a comment on an approved pull request whose head is behind the default branch is refused as not up to date, and nothing applies | Forgejo, github.com | proven |
| `security/check-token` | with GITLAB_TOKEN an unprotected variable the synth command of a branch runs in the check job with no forge token variable, and the check passes | GitLab | proven |
| `security/fork` | a pull request from a fork runs check and no plan job | Forgejo | proven |
| `security/plan-token-free` | the plan and re-plan jobs run the code of a pull request with no forge token variable in its environment or that of its parent processes and no credential in the checkout, and the note jobs still post the note and terragucci/plan | Forgejo | proven |
| `security/protected-token` | with gitlab.token protected, the merge request plan job holds no token and passes, and the comments job posts its plan note and terragucci/plan | GitLab | proven |
| `security/replan-apply-role` | a /terragucci plan re-plan trades its OIDC token for the plan role before any pull request code runs, and that code finds no token the apply role trusts and no way to ask for one | Forgejo | proven |
| `security/replan-cache` | a /terragucci plan re-plan restores the Terragrunt cache and saves none, so what the code of a pull request leaves in .terragrunt-cache never reaches an apply job | Forgejo | proven |
| `security/token-scrub` | the binary tf-plan starts gets no forge token by name or by value, and a TF_ variable passes as set | Forgejo | proven |
| `state/azurerm-unlock` | terragucci unlock-state reads the lease a killed apply left on an azurerm state blob, with the lock info in its metadata, and releases it only after an approval of that lock, recording who released it | Forgejo | proven |
| `state/gcs-unlock` | terragucci unlock-state reads the lock a killed apply left on a gcs backend, by the generation of the lock object, and releases it only after an approval of that lock, recording who released it | Forgejo | proven |
| `state/unlock` | terragucci unlock-state refuses to release a state lock while a run that began before it is alive, and once the apply that held it is killed releases it only after an approval of its lock ID, recording who released which lock, and the next wave applies | Forgejo, Forgejo (Terraform), Forgejo (choudoufu), GitLab | proven |

### Policy

14 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `cost/gate` | with cost.approve_above set, a wave whose monthly change is over the amount waits for an approval under gate: never, its log naming the change, the amount and the commit read, and the plan note of a pull request sets the change of each wave against the amount at base | Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `cost/policy` | with cost set, an HCP Terraform policy set reads the cost of the root from input.run.cost_estimate and of its wave from input.cost, and its mandatory policy denies the wave | Forgejo | proven |
| `policy/delete-key` | a pull request that deletes the policy key from terragucci.yml and adds a change the policy denies still fails tf-plan, checked against the policy of the base branch | Forgejo | proven |
| `policy/hcl` | with a policies.hcl a mandatory policy denies the wave and an advisory one warns | Forgejo | proven |
| `policy/hcp` | with policy.input: hcp an HCP Terraform policy reads input.plan and input.run and denies the wave | Forgejo | proven |
| `policy/opa` | with policy.engine: opa a tf-apply wave the policy denies applies nothing, and its report keeps the denial and the warnings | Forgejo | proven |
| `policy/override` | a tf-apply wave the policy denies applies once an approver listed under policy.override at base overrides its plan with terragucci override, and its report names the override with who, the rules, the reason and the plan digest; the next plan the policy denies exits 1 naming policy.override and the terragucci override command, an override by someone it does not list counts for nothing, and an override of a plan that moved on exits 4 | Forgejo, GitLab, github.com | passes |
| `policy/review-risk` | a tf-apply wave gives the policy the risk the review workflow of the default branch kept as its artifact for the head of the merged pull request as input.review; the edited review job of the pull request itself keeping risk low and a forged low-risk note posted with the pipeline token change nothing, and a policy that denies risk high stops the wave | Forgejo | proven |
| `policy/source` | a project of a control repo with no policy directory is checked against the shared policy source the control repo defaults name, at its pinned ref | Forgejo | proven |
| `policy/sources-at-base` | a pull request that adds an unlisted host to its own sources list is still refused, checked against the list of the base branch | Forgejo | proven |
| `policy/sources-module` | with sources.modules set, tf-plan and the check job fail a root that calls a module from an unlisted host before its init, and tf-plan fails one whose listed remote module calls an unlisted one after its init and before its plan, naming the module path; in a Terragrunt repo tf-plan fails such a unit after Terragrunt inits it and before its plan, naming the unit and the module path, and the check job fails a unit whose source is on an unlisted host before its validate | Forgejo | proven |
| `policy/sources-provider` | with sources.providers set, tf-plan fails a root whose required_providers names an unlisted provider before its init, and one whose remote module brings in an unlisted provider after its init and before its plan, naming the module; in a Terragrunt repo tf-plan fails a unit whose source brings in an unlisted provider after Terragrunt inits it and before its plan, naming the unit and the provider | Forgejo | proven |
| `policy/tofu` | an opt-in policy denies a plan, fails the root in tf-plan, and names the violation | Forgejo, GitLab, github.com | passes |
| `policy/wave` | a tf-apply wave whose plan the policy denies applies nothing, and its report keeps the changes of the denied root with the denial and the warnings | Forgejo, Forgejo (Terraform), Forgejo (choudoufu) | proven |

### Drift

13 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `drift/attribute` | with respond.drift: attribute, tf-drift lists who changed each drifted attribute under its root in the drift issue | Forgejo | proven |
| `drift/branches` | with apply.branches mapping release to canary, the drift run on main plans canary from release, the branch that applied it, and finds no drift where planning it from main would read the state release left behind and report a false drift | Forgejo | proven |
| `drift/choudoufu` | with binary: choudoufu a queue changed outside choudoufu on a root under live resource markers is drift: tf-drift plans the root in full, its report and one drift issue name the root and the attribute, and a run with no change closes the issue | Forgejo (choudoufu) | proven |
| `drift/close` | a drift run that finds no drift closes the drift issue an earlier run opened | Forgejo | proven |
| `drift/github` | on GitHub, a drift run opens the drift issue, and a second run finds it and updates it instead of opening another | GitHub | proven |
| `drift/issue` | the drift schedule opens one drift issue naming the root and attribute that drifted, updates the same issue when more drifts, and closes it when a run finds none | GitLab, github.com | passes |
| `drift/terragrunt-attribute` | with respond.drift: attribute in a Terragrunt repo, tf-drift lists who changed each drifted attribute under its unit in the drift issue | Forgejo | proven |
| `drift/terragrunt-stack` | tf-drift from a checkout that holds no generated unit generates the explicit stack, reports the resource deleted outside Terraform under its generated unit, and names the stack file that unit comes from | Forgejo | proven |
| `drift/tfquery` | with binary: terraform a root with a .tfquery.hcl gets the drift pull request with the config terraform query generated for what it lists | Forgejo (Terraform) | proven |
| `drift/tofu` | drift is reported by root | Forgejo, Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `note/drift-overdue` | the plan of a pull request says in its note that drift checks are overdue when the drift schedule has come round twice with no drift run | Forgejo | proven |
| `respond/drift` | drift on a literal becomes a pull request with the live value, and import blocks for what is unmanaged | Forgejo | proven |
| `respond/terragrunt-drift` | a drifted Terragrunt unit gets a pull request that writes the live value into its own terragrunt.hcl inputs and leaves the module its units share alone | Forgejo | proven |

### Chat and notify

6 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `chat/lambda` | the relay built as the AWS Lambda function of the guide, run under the Lambda runtime interface emulator, takes a signed Slack click as a function URL event and records the approval of that digest as the mapped principal; the resume workflow then applies the wave | Forgejo | proven |
| `chat/replan` | with notify naming a Slack webhook, a drift run that finds drift posts the drifted root with a Re-plan button that opens the drift workflow, which runs on workflow_dispatch | Forgejo | proven |
| `chat/slack` | a click on the Approve button of the Slack message of a waiting wave, signed with the signing secret of the app, reaches the relay, which maps the Slack user to their principal in the signers file, records the approval of that digest as them and says so in the thread; the resume workflow then applies the wave | Forgejo | proven |
| `chat/teams` | a Teams reply that approves a waiting wave, signed as an outgoing webhook signs it, reaches the relay, which maps the Teams user to their principal in the signers file and records the approval of that digest as them; the resume workflow then applies the wave | Forgejo | proven |
| `notify/chat` | with notify naming a Slack and a Teams webhook secret and approval: pr-review, a wave of a merged pull request that waits posts the wave, its root, the digest, the approve command, the run and a link to review the pull request to each, and once that review lands the next run applies it | Forgejo | proven |
| `notify/webhook` | with notify naming a generic webhook and its key, a wave that waits posts a chant.notify/v1 event signed with HMAC-SHA256 over its body, carrying the outcome, digest and approve command | Forgejo (Terraform), Forgejo (choudoufu) | proven |

### Reports and visibility

46 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `audit/control` | terragucci audit in a control repo fetches each project ledger from its url and reads each project reports into one record | Forgejo | proven |
| `audit/override` | the audit record keeps a policy refusal after its report is replaced, and holds the override with its reason and rules and the apply under it | Forgejo | proven |
| `audit/refused` | a wave whose plans changed after approval is in the audit record as refused, with the approver, the digest approved and the root that moved | Forgejo | proven |
| `audit/tofu` | terragucci audit writes one record to the bucket: every approval on the ledger with its approver, digest and time and who relayed it, the request, and the apply that names its approval; --check passes and the estate page links the audit page | Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `behold/serve` | behold serve, given the checkout and the reports bucket, draws both roots, marks the queue deleted outside Terraform with the time the drift check finished, gives the terragucci approve line of the waiting wave and refuses a deploy, and refuses a corrupted index.json | Forgejo | proven |
| `behold/terragucci-view` | terragucci view, reading the bucket and project from terragucci.yml, starts the pinned behold, which draws both roots, marks the queue deleted outside Terraform with the time the drift check finished and gives the terragucci approve line of the waiting wave, and stops on SIGTERM; a corrupted index.json stops it with one line | Forgejo | proven |
| `behold/view` | the behold step of the estate job reads the reports from the bucket and publishes the view of the commit under views/behold/<commit>/ with latest.json and history.json naming it, and headless Chrome, opening views/behold/ from the bucket, draws the drift the drift check found on the card of the deleted queue | Forgejo | proven |
| `estate/control` | terragucci estate in a control repo reads each project from its own bucket with its own reports.role and writes one page to the bucket under defaults | Forgejo | proven |
| `estate/dora` | terragucci estate computes the four DORA metrics from the audit trail and the indexes into dora.json and the estate page: deployments, lead time with the share at the gate, a change failure rate counting a failed apply and an applied wave that drifted, and the time to restore each | Forgejo | proven |
| `estate/graph` | the estate page draws the example roots by wave with an edge for each state the example reads and an edge from a root of another project that reads one, and the run view shows the blast radius of wave 1 and a timeline of the plan, gate wait and apply of each wave | Forgejo, Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `estate/history` | one resource changed by three approved applies has a history that lists the three in order with their approvers from the audit trail, linked from the estate page, and no value | Forgejo, Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `estate/inventory` | after two apply waves of the example roots the estate page lists every resource of each root by address, type and provider, with the count of each type, and no value | Forgejo, Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `estate/job` | the estate job of the see-every-project page, pasted into .gitlab-ci.yml and run by a pipeline schedule with only its OIDC token, writes estate.html listing the project to the bucket and prints a presigned link | GitLab | proven |
| `estate/override` | the estate page counts the roots applied under a policy override, in estate.json and estate.html | Forgejo | proven |
| `estate/query` | terragucci query, run on the reports bucket with no server, answers the SQS queues changed in the last 7 days with their approvers with the rows the audit trail holds | Forgejo | proven |
| `estate/state-edges` | the estate page lists a root that reads the state of another with its last plan against the last apply of the producer: stale after the producer alone applied, current once the consumer planned again | Forgejo | proven |
| `estate/terragrunt-graph` | in a Terragrunt repo the plan note gives the blast radius of a changed unit through the units that depend on it, and the run view and the estate graph hold each unit by wave with an edge for each dependency block | Forgejo | proven |
| `estate/terragrunt-remote-state` | a Terragrunt unit whose root.hcl remote_state builds its key from path_relative_to_include() holds that state in its run view, and the estate graph draws an edge to the root of another project that reads it through terraform_remote_state | Forgejo | proven |
| `estate/tofu` | terragucci estate writes one page to the reports bucket from the index of every project: three projects, a waiting wave with its age and a drift, with a presigned link to the page | Forgejo | proven |
| `note/report-link` | with reports.bucket set and no reports.url, the plan note links report.html and each plan.txt in the bucket by presigned links, which open from floci | Forgejo | proven |
| `report/azure` | with reports.bucket az://<account>/<container> and only the Azure OIDC identity of the job, tf-plan writes the report and both indexes to Azure Blob Storage, and terragucci estate writes the page there and prints a user delegation SAS that serves it | Forgejo | proven |
| `report/azure-key` | with AZURE_STORAGE_KEY the job writes the report and both indexes to Azure Blob Storage, and the estate link is a SAS signed with the account key | Forgejo | proven |
| `report/contracts` | the index.json files, estate.json and report.json a run and terragucci estate write to the bucket hold to the JSON Schemas the package ships, and a project named views writes nothing under the prefix kept for viewers | Forgejo | proven |
| `report/drill-down` | the plan note links the report in the bucket, the report links each root plan and the trace of the run, the trace and the dashboards link back to the report, and the index row links the commit, pull request and job | Forgejo | proven |
| `report/front-door` | the front door template puts CloudFront in front of the private reports bucket at its own domain, reads the bucket through Origin Access Control and runs the sign-in check on every viewer request | Forgejo | proven |
| `report/gcs` | with reports.bucket gs://<bucket> and only the GCP OIDC identity of the job, tf-plan writes the report and both indexes to GCS through its JSON API, and terragucci estate writes the page there and prints a V4 signed URL that the service account signed | Forgejo | proven |
| `report/gcs-key` | with a service_account key file the job writes the report and both indexes to GCS, and the estate link is signed with the key | Forgejo | proven |
| `report/index-writes` | two plan runs that write one index at once both land in it, and a store that answers 501 to a conditional write gets the row without the condition | Forgejo | proven |
| `report/keys` | with the bucket keys in CI/CD variables, which the pipeline maps nowhere, the plan job writes report.json to the bucket and the index lists the run | GitLab | proven |
| `report/oidc` | with no static keys, the plan job writes its report to the bucket as the role it assumes with its OIDC token through STS, and the index lists the run | Forgejo, GitLab | proven |
| `report/tofu` | the report is JSON and HTML, and links every root to its full plan | Forgejo, Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `report/wave` | the report of a tf-apply wave behind a gate says waiting and links the ledger that holds its record, and approved once an approval of its digest stands | Forgejo | proven |
| `telemetry/alerts` | with short thresholds every alert init writes fires on its signal, and the apply-success and drift-corrected SLOs record | Forgejo | proven |
| `telemetry/dash-changes` | the Change review dashboard init writes shows the roots, groups and changes by action of a pull request | Forgejo | proven |
| `telemetry/dash-drift` | the Drift dashboard init writes shows the roots a drift run found drifted and how old the drift is | Forgejo | proven |
| `telemetry/dash-estate` | the Estate dashboard init writes shows the roots of a project and the binary and terragucci versions it runs | Forgejo | proven |
| `telemetry/dash-pipeline` | the Pipeline health dashboard init writes shows the runs, errors and results of a plan, a drift run and a gated wave | Forgejo | proven |
| `telemetry/dash-runs` | the Runs dashboard init writes shows the slowest roots, stage durations and the trace of each run from Tempo | Forgejo | proven |
| `telemetry/dash-slos` | the SLO dashboards init writes are provisioned, and the plan SLO records the plans of a project from the rules init writes | Forgejo | proven |
| `telemetry/dash-waves` | the Rollouts and waves dashboard init writes shows a wave waiting for its approval, how long, and wave runs by result | Forgejo | proven |
| `telemetry/headers` | telemetry.headers_secret maps the collector key into the jobs, spans reach a collector that wants it, and a collector that does not answer leaves the plan green | Forgejo | proven |
| `telemetry/metrics` | the metrics of a plan run reach Prometheus with the counts in its report | Forgejo | proven |
| `telemetry/provider-calls` | with binary: choudoufu the report lists the slowest provider calls of a root, each with its method, provider and resource type, from the provider call spans choudoufu sends | Forgejo (choudoufu) | proven |
| `telemetry/summed-timings` | with binary: choudoufu past its span budget the report lists the timings choudoufu summed by resource type, and the note of the root says it summed them | Forgejo (choudoufu) | proven |
| `telemetry/terragrunt-spans` | the plan of each Terragrunt unit sends its spans to the report through the TG_TF_PATH wrapper, and waits up to five minutes for the state lock | Forgejo | proven |
| `telemetry/traces` | each plan run is one trace, with a span per root and the binary spans inside it | Forgejo | proven |

### Modules

11 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `modules/attest` | with modules.attest each release is signed, attested and recorded in the release ledger with its tag | Forgejo | proven |
| `modules/publish` | changed modules are published at a new version | Forgejo, GitLab, github.com | passes |
| `modules/recorded` | with modules.require: attested tf-plan refuses a root that pins a version the release ledger does not record | Forgejo | proven |
| `modules/registry` | with modules.registry each release is written as the module registry protocol to a bucket, and a root that pins ~> 1.0 resolves the newest 1.x from it; with modules.test an untested release is refused | Forgejo | proven |
| `modules/require` | with modules.require: attested tf-plan plans a root that pins an attested release, and refuses one whose tag was moved | Forgejo | proven |
| `modules/terragrunt-require` | with modules.require: attested in a Terragrunt repo tf-check and tf-plan refuse a unit whose terraform source pins an unattested release, and pass one that pins an attested release | Forgejo | proven |
| `modules/version-bump` | with respond.version-bump: suggest, the version-bump job of the pipeline runs after the last apply on the default branch and opens a release pull request with the answer of the decision service | Forgejo | proven |
| `respond/notes` | release notes come from the conventional commits that touched the module | Forgejo | proven |
| `rollout/control` | from a control repo a module rollout opens wave 1 as one pull request per project for its canaries, then each project in turn, each wave once the last applied | Forgejo | proven |
| `rollout/pins` | rollout moves a provider alone in the lock file and its exact constraint, an oci:// tag and a registry version pin, each in the shape it had | Forgejo | proven |
| `rollout/tofu` | a module version rolls out one merge request per wave, each changing only its roots and opened only after the last wave merged and applied | GitLab, github.com | passes |

### State and migration

17 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `apply/atmos-workspace` | each Atmos instance plans and applies in the Terraform workspace Atmos names for it, never default: the instances of one component in two stacks keep their own states, and plan no change after the apply | Forgejo | proven |
| `choudoufu/migrate` | with binary: choudoufu two migrations in one change apply in one wave, each proved and approved by its digest: one moves a resource between two estates by rewriting its ownership tags and records the move on chant/lifecycle, the other adopts a root on s3 state into an estate, stamps its resources and leaves the old state as the version it was; the next plan of every root shows no change | Forgejo (choudoufu) | proven |
| `choudoufu/record-versions` | with binary: choudoufu a record changed by three tf-apply waves shows three versions, newest first, on the estate page and in its history, listed by choudoufu live-history | Forgejo (choudoufu) | proven |
| `choudoufu/shared-bucket` | with binary: choudoufu one tf-apply wave applies two estates into one record store bucket, each under its own prefix and estate tag, and the next plan of both shows no change | Forgejo (choudoufu) | proven |
| `migrate/backends` | one migration moves the states of six roots to new backends, from s3, a TFE workspace, pg, kubernetes, consul and http: each source read by version, through discovery or with state pull, proved with no change, approved by digest, written under the lock of its backend, each source left as it was, and the versions read and written recorded where the backend keeps them | Forgejo | proven |
| `migrate/blob` | a migration moves a resource from a root whose state is on GCS to one whose state is on Azure Blob Storage: approved by digest, written under the lock object and the blob lease, and each version before and after recorded | Forgejo | proven |
| `migrate/cdktn` | a migration moves a resource between two CDK Terrain stacks, whose roots are cdk.tf.json: wave 1 proves it with no change on those roots, waits for its digest, and once approved writes both states under their lock files | Forgejo | proven |
| `migrate/resume` | with gate: never and apply.resume set, init still writes the resume workflow, terragucci approve with no argument approves a migration that waits in wave 1 of a Forgejo run, and one run of the resume workflow writes both states and applies, with nobody running wave 1 again | Forgejo | proven |
| `migrate/split` | a migration file splits one root into two: the plan proves it with no change, wave 1 waits for its digest, and once approved writes both states under their locks with no change, recording each version before and after; terragucci migrate revert then writes the migration that puts each state back to the version the split recorded, refused when a state moved past the version the split left | Forgejo | proven |
| `migrate/terragrunt-split` | a migration file moves a resource from the state of one Terragrunt unit to that of another: wave 1 proves it on the units Terragrunt prepares, waits for its digest, and once approved writes both states under their locks at their remote_state keys, recording each version before and after | Forgejo | proven |
| `state/azurerm` | a root whose azurerm backend on Azurite takes snapshots applies twice, each wave naming the snapshot it took of the state blob, and terragucci state export writes the first snapshot once someone else approved the request | Forgejo | proven |
| `state/export` | terragucci state export records a request, waits for an approval by someone else, then writes the state version on the machine of the person who asked, recorded on chant/lifecycle and in the audit trail, with no state in the bucket | Forgejo, GitLab | proven |
| `state/gcs` | a root whose state is in a bucket on fake-gcs-server with object versioning applies twice, each wave naming the generation it left, and terragucci state export writes the first generation once someone else approved the request | Forgejo | proven |
| `state/gitlab-managed` | a root on GitLab-managed state applies with its backend password passed as TF_HTTP_PASSWORD from the job token, and GitLab holds its state | GitLab | proven |
| `state/terragrunt-export` | terragucci state export of a Terragrunt unit prepares it through Terragrunt, asks for the version of the state its remote_state block names, and once someone else approved it writes that version on the machine of the person who asked, recorded on chant/lifecycle | Forgejo | proven |
| `state/terragrunt-versions` | a Terragrunt unit whose state is in a versioned S3 bucket applies twice, its backend read from its remote_state block, and the estate page lists both state version ids newest first, each one the bucket holds | Forgejo | proven |
| `state/versions` | a root whose state is in a versioned S3 bucket applies twice, and the estate page lists both state version ids newest first, each one the bucket holds, and no state content | Forgejo, GitLab | proven |

### Agents and pull request environments

10 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `agent/comment` | a /terragucci agent comment pushes the commit of the stand-in agent to the branch of the pull request, which re-plans it and is linked in the reply, and a forbidden path, a non-writer and a fork push nothing | Forgejo, GitLab, github.com | passes |
| `agent/drift` | with agent.drift on, a drift run that opens the drift issue runs the stand-in agent with no forge token in its step, and the push job opens a pull request with its change, which plans like any other and is linked on the issue | Forgejo | proven |
| `agent/review` | with review.agent on, the review workflow of the default branch runs on pull_request_target after the plan, and its review job runs a stand-in reviewer on the pull request, its plan and the instructions of the default branch, with the key of the model and no forge token, and the note it posts flags a destroy the description does not mention and approves nothing | Forgejo, GitLab | proven |
| `ephemeral/cdktn` | with synth set, opening a pull request runs the synth command in its checkout and applies its own copy of a CDK Terrain stack at the key suffixed -pr-<n>, beside the state of the stack itself, and closing it destroys the copy on the record | Forgejo | proven |
| `ephemeral/pr` | with ephemeral naming canary/*, opening a pull request applies its own copy of canary/one under the state key suffixed -pr-<n>, beside the state of the root itself, and closing it destroys the copy through a planned destroy recorded on chant/lifecycle with the reason closed | Forgejo, GitLab | proven |
| `ephemeral/terragrunt` | in a Terragrunt repo whose remote_state key reads TERRAGUCCI_EPHEMERAL_SUFFIX, opening a pull request applies its own copy of a unit at the key suffixed -pr-<n>, prepared through Terragrunt, beside the state of the unit itself, and closing it destroys the copy on the record | Forgejo | proven |
| `ephemeral/ttl` | with ephemeral naming canary/* and a TTL of one minute, a run of the sweep workflow once the TTL has passed destroys the copy of an open pull request through a planned destroy recorded with the reason expired | Forgejo | proven |
| `estate/mcp` | an MCP client of terragucci mcp, which reads the reports bucket with the credentials of its environment, reads the last apply of a root, and the server lists only read-only tools and refuses an approve call and a token argument | Forgejo | proven |
| `respond/explain-refusal` | after a wave is refused, the explain-refusal job of the agent-refused-wave page runs wave-refused on the wave reports and a stand-in agent prints a summary naming the root whose plan moved, and a branch pipeline still runs | GitLab, github.com | passes |
| `review/description` | with respond.description: check the plan job flags a destroy the pull request description leaves out, at the top of the note and in the report, and writes intent.json; decide.backend laya, von, decider and jev each answer the check through the same client, each pinned to its model, jev with its bearer token from token_env | Forgejo | proven |

### Setup and runtime

47 claims.

| Claim | What it checks | Where it runs | Result |
|---|---|---|---|
| `apply/provider-cache-no-lock` | with binary: terraform, a wave of eight roots with no .terraform.lock.hcl and one whose lock names the OpenTofu registry plans at once on one shared provider cache: every root plans, the job log names one download, and no init fails with text file busy | Forgejo (Terraform) | proven |
| `apply/runner-nudge` | on the validation stack a job left waiting after the run ahead of it in its concurrency group is cancelled, with nothing running, starts within three minutes: a wait restarts the idle runner | Forgejo | proven |
| `binary/terraform` | with binary: terraform the pipeline runs in the terraform image, check and the plan pass, and a wave waits for its approval and then applies with Terraform | Forgejo (Terraform) | proven |
| `binary/terragrunt-choudoufu` | in a Terragrunt repo with binary: choudoufu the jobs run in the choudoufu image with Terragrunt installed beside it, and every unit plans with choudoufu through TG_TF_PATH | Forgejo (choudoufu) | proven |
| `binary/terragrunt-terraform` | in a Terragrunt repo with binary: terraform the pipeline installs Terraform and Terragrunt applies every unit with it | Forgejo (Terraform) | proven |
| `boot/tofu` | the example boots and deploys locally | Forgejo, Forgejo (Terraform), Forgejo (choudoufu) | proven |
| `choudoufu/iam` | with binary: choudoufu a role granted one estate by its ownership tag applies a change to that estate, and IAM refuses it a change to an instance of another estate | Forgejo (choudoufu) | proven |
| `forge/check` | terragucci forge check exits 0 when main is protected and each role in floci trusts exactly what config identities prints, and exits 1 with a row naming the expected and found value when main is unprotected, a role trusts any subject, or a role trusts an extra audience; it runs with a Forgejo token scoped read:repository and AWS keys granted iam:GetRole alone, and sends no request but GET and GetRole | Forgejo | proven |
| `generate/cdktn` | with synth set init and terragucci generate refuse a generate key as a config error that names the CDK Terrain constructs that set a backend | Forgejo | proven |
| `generate/terragrunt` | in a Terragrunt repo terragucci generate writes terragucci.hcl from terragucci.yml, the check step passes it, and each unit that includes it applies with the backend key and provider settings generate gives it, while a unit that does not include it is refused by name | Forgejo | proven |
| `generate/terragrunt-init` | with generate.disable_init: false terragucci generate writes disable_init = false in the remote_state of terragucci.hcl, the check step passes it, and the apply job has Terragrunt create the missing state bucket and applies into it | Forgejo | proven |
| `generate/tofu` | terragucci generate writes the backend, provider and version files of each root from the repo, directory glob and root levels of terragucci.yml, a changed global reaches the backend file of every root, and tf-check refuses a hand-edited generated file | Forgejo | proven |
| `import/atlantis` | terragucci import atlantis writes terragucci.yml from an atlantis.yaml, names what it leaves out, and the pipeline init then writes plans exactly the Atlantis projects | Forgejo | proven |
| `import/env0` | terragucci import env0 writes terragucci.yml from env0_* code, env0.yml and env0-discovery.yml, and init then plans the environment roots, keeps ephemeral copies of the ones with a TTL, and holds every wave for an approval | Forgejo | proven |
| `import/hcp` | terragucci import hcp reads the workspaces of an organization over the TFE API, only reading, and writes a root per workspace directory, lists a directory several workspaces run to split, names sensitive variables as secrets without their values, and init then applies in the order the run triggers ask | Forgejo | proven |
| `import/scalr` | terragucci import scalr reads the workspaces of a Scalr account over the Scalr API, only reading, and writes their roots on tofu with the sensitive variables as secrets the pipeline passes, without their values, and names the policies of each OPA policy group | Forgejo | proven |
| `import/spacelift` | terragucci import spacelift writes terragucci.yml from spacelift_* code and .spacelift/config.yml, with context secrets to create and hooks as steps, and init then applies the roots in the order the stack dependencies ask | Forgejo | proven |
| `import/terragrunt-scale` | terragucci import terragrunt-scale writes the plan and apply roles of each Gruntwork Pipelines environment as terragrunt.credentials, and every unit then assumes the roles of its environment, a unit with its own gruntwork.hcl its own | Forgejo | proven |
| `init/atmos-refuse` | config check and init refuse the drift pull request of an Atmos repo in the same words, about the vars of the stack, never synth; respond tips proposes lock files for the components and a canary of instances | Forgejo | proven |
| `init/atmos-version` | atmos.version in terragucci.yml is the Atmos release every job installs | Forgejo | proven |
| `init/cdktn-refuse` | with synth set init refuses the drift pull request and rollouts as config errors saying why, and with respond.drift: attribute the drift job runs no pull request | Forgejo | proven |
| `init/config-ts` | init writes the pipeline from a terragucci.ts folded as data, and config check refuses a terragucci.ts that reads process.env at its line | Forgejo | proven |
| `init/env` | with env setting TF_VAR_greeting, init writes it into the pipeline, and the apply job applies the root with that value in its state | Forgejo | proven |
| `init/foreign-checkout` | a job that runs as root in the CI image on a checkout another user owns, with no git setting of its own, plans only the roots a change touches | Forgejo | proven |
| `init/image` | with image naming an image built from the terragucci image, init writes it into every job of the pipeline and the jobs run in it: check passes, a step prints a file only that image holds, and the root applies | Forgejo | proven |
| `init/own-jobs` | with own_jobs naming a file of jobs in terragucci.yml, init run twice keeps the job in the Forgejo pipeline as the file has it, and the job runs after the check job and passes | Forgejo | proven |
| `init/pass-secrets` | with pass naming a repo secret and a repo variable, init writes their names and never their values into the jobs that plan and apply, and the apply job applies the root with both values in its state | Forgejo | proven |
| `init/pinned-install` | a pinned binary version the image does not carry is installed in the job and checked against the SHA256SUMS of its release | Forgejo | proven |
| `init/role-refused` | config check and init refuse an oidc block that names one role for plan and apply | Forgejo | proven |
| `init/root-pins` | two roots of one wave plan on two OpenTofu versions, the one the .opentofu-version of a root pins, installed in the job and checked against its SHA256SUMS, and the one in the image, and the report and the plan note name the binary and version of each root | Forgejo | proven |
| `init/runner-label` | with runner.apply naming a label only a second Forgejo runner serves, init writes it as the runs-on of the apply jobs alone, and the push to main runs check on the runner of the stack and the apply job on the labelled one | Forgejo | proven |
| `init/terragrunt` | init finds Terragrunt and its 15 units on its own and writes the pipeline the Terragrunt example commits | Forgejo | proven |
| `init/terragrunt-root-pins` | three Terragrunt units of one wave plan with their own releases: the tofu the .opentofu-version of a unit pins and the Terragrunt its terragrunt_version_constraint pins, each installed and checked in the job, and the releases of the image for the third, and the report names each | Forgejo | proven |
| `init/zero-config` | with no more than a drift schedule and the canary wave in terragucci.yml, init writes the same pipeline | Forgejo | proven |
| `oidc/atmos-roles` | oidc.roles by stack glob gives the instances of each Atmos stack roles of their own: config check lists each role with the states of its stack, and each instance plans and applies as the role of its stack | Forgejo | proven |
| `oidc/audience-stages` | with oidc.audience a map, the plan job of a pull request and the apply job of main each hold a token for their own stage audience, a role whose trust names the apply audience refuses the plan token, and the code each job runs finds no token-request variable in its environment | Forgejo | proven |
| `oidc/cloud-roles` | with oidc.gcp.roles and oidc.azure.roles, the roots of each environment plan and apply with the service account and the client of their glob, from the exports of the pipeline, and never the identity of the job | Forgejo | proven |
| `oidc/clouds` | a job with oidc.gcp and oidc.azure gets an external_account file and the ARM_* variables the google and azurerm providers read, with a token for the audience of each cloud | Forgejo | proven |
| `oidc/forgejo` | a Forgejo job gets an OIDC token Forgejo signed for its repo and ref, and trades it for the plan or apply role | Forgejo | proven |
| `oidc/gitlab` | the merge request plan job holds a GitLab id_token for sts.amazonaws.com naming this project, pipeline and job, for the plan role, and the apply job on main one for the apply role; the token is verified against the keys the lab publishes, not traded with STS | GitLab | proven |
| `oidc/job` | the plan job holds a GitHub-signed OIDC token for this repo and run, for the plan role, and the apply job on main one for the apply role; with no cloud account the token is checked, not traded with STS | github.com | passes |
| `oidc/state-roles` | with oidc.roles each environment root plans and applies as the role of its own environment, config check lists the state key of each role, and it warns when a prod root reads the dev state | Forgejo | proven |
| `oidc/terragrunt` | in a Terragrunt repo each unit assumes the plan role of the first glob its path matches, and a unit with its own iam_role keeps it | Forgejo | proven |
| `reconcile/mixed` | a control repo with projects on Forgejo, on GitHub (the mock) and on a forge that does not answer opens the Forgejo pull request and the GitHub one, each with its own pipeline, names the project that failed, and exits 1 | Forgejo, GitLab | proven |
| `reconcile/parallelism` | a project of a control repo plans with the parallelism its defaults set: reconcile writes the key into the terragucci.yml of the project, and the plan job reads it there | Forgejo | proven |
| `reconcile/provider` | the terragucci provider, applied with tofu, writes a project and the defaults into the terragucci.yml of a control repo, plans show a changed setting, and reconcile gives the project its pipeline with the setting | Forgejo | proven |
| `reconcile/tofu` | a control repo opens one pull request per project that changes, and the merged pipeline applies | Forgejo, GitHub, GitLab | proven |

### Recorded but not in a feature area

| Claim | What it checks | Result |
|---|---|---|
| `apply/steward` | tf-apply runs as a turn on a fountain steward, started by the forge job, and applies every root | not run yet |

## Not yet proven

39 cells of the feature-area grids (feature area by tool, and by forge) have no proven claim. "same code" means the area runs the same code on that binary as on OpenTofu and has no claim of its own there.

| Tool or forge | Feature area | Now |
|---|---|---|
| Terraform | Plan and review | same code |
| Terraform | Modules | same code |
| Terraform | State and migration | same code |
| Terraform | Agents and pull request environments | same code |
| choudoufu | Modules | same code |
| choudoufu | Agents and pull request environments | same code |
| Terragrunt | Policy | none |
| Terragrunt | Chat and notify | none |
| Atmos | Policy | none |
| Atmos | Drift | none |
| Atmos | Chat and notify | none |
| Atmos | Reports and visibility | none |
| Atmos | Modules | none |
| Atmos | Agents and pull request environments | none |
| Terramate | Locks and safety | none |
| Terramate | Policy | none |
| Terramate | Drift | none |
| Terramate | Chat and notify | none |
| Terramate | Reports and visibility | none |
| Terramate | Modules | none |
| Terramate | State and migration | none |
| Terramate | Agents and pull request environments | none |
| Terramate | Setup and runtime | none |
| CDK Terrain | Policy | none |
| CDK Terrain | Drift | none |
| CDK Terrain | Chat and notify | none |
| CDK Terrain | Reports and visibility | none |
| CDK Terrain | Modules | none |
| GitHub | Plan and review | passes |
| GitHub | Approve and apply | passes |
| GitHub | Policy | passes |
| GitHub | Drift | passes |
| GitHub | Chat and notify | none |
| GitHub | Reports and visibility | none |
| GitHub | Modules | passes |
| GitHub | State and migration | none |
| GitHub | Agents and pull request environments | passes |
| GitHub | Setup and runtime | passes |
| GitLab | Chat and notify | none |

`npx tsx scripts/coverage-gaps.ts` prints the same list with what fills each cell.

## Refused by design

| Tool or forge | Feature area | What is refused |
|---|---|---|
| GitLab | Locks and safety | Locks from the first plan (locks: plan) are refused on GitLab, where no merge request event runs a job from the default branch. |
| Terragrunt | Setup and runtime | A Terragrunt repo takes no synth, so a CDK Terrain app cannot run in one. |
| CDK Terrain | Setup and runtime | A CDK Terrain app cannot run in a Terragrunt repo, which takes no synth. |
| Atmos | Drift | The drift pull request is refused: a live value belongs in the stack vars or the component. |
| Terramate | Drift | The drift pull request is refused: a live value belongs in the stack .tm.hcl or its own Terraform. |
| CDK Terrain | Drift | The drift pull request is refused: a live value belongs in the app that writes the stacks. |
| Atmos | Modules | Rollouts are refused: every instance of a component shares its files, so no wave can move a pin alone. |
| Terramate | Modules | Rollouts are refused: the pin is usually in code terramate generate writes. |
| CDK Terrain | Modules | Rollouts are refused: the pin is in the app that writes the stacks. |
| Atmos | Agents and pull request environments | A copy per pull request is refused: the stack backend and workspace name the state of an instance. |

## Harness scenarios

Longer runs on the same stack, driven by chant's e2e harness: each is a file under `stack/harness/scenarios/<id>/scenario.json` that opens pull requests, merges, kills jobs and checks the forge, then runs again with its property broken. `npx tsx stack/harness/harness.ts lint` checks the files. Results are recorded as claim rows when `stack/harness/harness.ts run <id> --record` runs; a scenario with no row has not been recorded yet.

| Scenario | Claim | Binary | What it checks | Result |
|---|---|---|---|---|
| `multi-region` | `estate/multi-region` | Terraform | aws-bench's ec2-multiregion estate plans and applies on floci through the generated pipeline: six instances over three regions, and a change that reaches one region | not recorded |
| `tg-action-run` | `action/gated-invoke` | Terraform | A day-2 action asked from a pull request comment waits for an approval by someone else, and the resume job runs it once the approval stands | not recorded |
| `tg-agent-request` | `template/agent-request` | OpenTofu | An agent asks for an app over terragucci mcp --propose and gets the same pull request a person's request gets, planned, merged and applied the same way | not recorded |
| `tg-behold-action` | `behold/action-button` | Terraform | behold's action button asks for a day-2 action, the request waits for someone else's approval, the resume job runs it, and behold's timeline shows it | not recorded |
| `tg-behold-addon` | `behold/addon-form` | OpenTofu | behold's Add an add-on form asks for a cache on an app; the request workflow opens the pull request, it applies, and behold's apps read lists the add-on | not recorded |
| `tg-behold-request` | `behold/template-form` | OpenTofu | behold's Templates form asks for an app; behold dispatches terragucci's request workflow, which opens the pull request, and it plans | not recorded |
| `tg-compose-atmos` | `choudoufu/compose-atmos` | choudoufu | choudoufu's Atmos demo tree, run by its own Forgejo workflow: the pull request plans the affected components with choudoufu, and the merge deploys the reviewed plan | not recorded |
| `tg-compose-ci-pipelines` | `choudoufu/ci-pipelines` | choudoufu | The ci-pipelines example's own Forgejo workflows: live-check and live-plan pass on the pull request, the merge's live-apply stops at chant's gate, and the re-run after the approval applies | not recorded |
| `tg-compose-cross-estate` | `choudoufu/cross-estate-dependency` | choudoufu | The cross-estate-dependency example's own Forgejo workflows apply the network estate, then the service estate that reads its VPC by its markers | not recorded |
| `tg-compose-terragrunt` | `choudoufu/compose-terragrunt` | choudoufu | choudoufu's Terragrunt demo tree, run by its own Forgejo workflow: the pull request plans every unit with choudoufu, and the merge applies the reviewed plan | not recorded |
| `tg-derived-store` | `choudoufu/derived-store` | choudoufu | A root that keeps its backend block records into the backend's bucket, with no record_store written | not recorded |
| `tg-estate-overlap` | `choudoufu/rows-overlap` | choudoufu | Two pushes that change different resources of one estate apply at once, and a killed wave's held row is taken over by the next | proven |
| `tg-migrate` | `choudoufu/migrate-stock-in` | choudoufu | A stock root on s3 state is adopted into an estate under an approval of its digest, and live-check refuses a root that ignores its markers | not recorded |
| `tg-template-addon` | `template/addon-request` | OpenTofu | An add-on request adds one module call to an existing app's root, wired to the app module's output, and the app's one plan and apply take it | not recorded |
| `tg-template-app` | `template/app-request` | OpenTofu | A request names a template, an app and its inputs, and terragucci opens the pull request that adds the app's root, which plans, merges and applies like any other | not recorded |
| `tg-template-upgrade` | `template/upgrade-waves` | OpenTofu | A template's new version reaches every app built from it through the module rollout, canary first, one pull request per wave, titled by the apps it moves | not recorded |
