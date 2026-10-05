---
title: Responses to pipeline events
description: What terragucci does when a plan finishes, a wave is refused, an apply fails or drift is found, and where an agent may help.
---

Every pipeline event has a response that needs no model, and that response is the default. A project may add a model on top for one event at a time. Approving, applying and merging stay with people.

| Event | Response (default) | With `agent` |
|---|---|---|
| plan finished | the grouped summary as the pull-request note | an explanation added to the note |
| wave refused | a root-by-root diff of the approved plan against the current one, naming the attributes that moved | not offered |
| apply failed | triage from a table of known provider errors, each with its likely fix | the errors the table does not know |
| drift found | a pull request that writes the live value where the root sets a literal, and import blocks with generated config for resources the state does not hold | drift reached through variables, modules or expressions |
| tip raised | one small pull request per tip: pin a provider from its lock file, add a lock file, add a canary | not offered |
| format check failed | a `fmt` commit on the pull request's branch, on request | not offered |
| module published | release notes from conventional commits | polished notes |
| rollout wave merged | the next wave's pull requests, as `tf-rollout` opens them | not offered |
| reviewer question | none | an answer from the report and the code |
| module changed with no conventional commit | none; `tf-publish` proposes a patch | a suggested bump in a release pull request, from the typed-decision service |
| pull request opened or updated | none | not offered; with `respond.description: check`, a typed decision flags a description that leaves out what the plan destroys or replaces |

## Choosing a response

Set a response per event under `respond` in `terragucci.yml`. A key you leave out keeps its default.

```yaml
respond:
  drift: pull-request        # the default; attribute names who changed each attribute; agent adds a proposal for the rest
  apply-failed: triage       # the default; agent adds the long tail
  plan: summary
  question: off              # agent only
```

| Key | Takes | Default |
|---|---|---|
| `plan` | `summary`, `agent` | `summary` |
| `wave-refused` | `diff`, `off` | `diff` |
| `apply-failed` | `triage`, `agent`, `off` | `triage` |
| `drift` | `pull-request`, `attribute`, `agent`, `off` | `pull-request` |
| `tips` | `pull-request`, `off` | `pull-request` |
| `fmt` | `commit`, `off` | `commit` |
| `publish` | `notes`, `agent`, `off` | `notes` |
| `rollout` | `next-wave`, `off` | `next-wave` |
| `question` | `off`, `agent` | `off` |
| `version-bump` | `suggest`, `off` | `off` |
| `description` | `off`, `check` | `off` |

`agent` needs an integration to run in. When none is set, `terragucci config check` names the event and the missing keys.

```yaml
agent:
  via: forge                 # or fountain
  token_env: AGENT_FORGE_TOKEN
  role: arn:aws:iam::123456789012:role/terragucci-plan   # optional, read-only
```

The token is a forge App token that can comment and open pull requests. The role is the read-only plan role or one of its own. Naming the apply role is an error.

## Running a response

Each response is a command. A dry run is the default, and `--mode apply` opens the pull request or pushes the commit.

```bash
terragucci respond plan --report terragucci-report
terragucci respond wave-refused --approved terragucci-report/approved --current terragucci-report/current --wave 2
terragucci respond apply-failed --log apply.log
terragucci respond drift --mode apply
terragucci respond drift --root envs/prod/orders --import aws_sqs_queue.extra=https://sqs.us-east-1.amazonaws.com/123456789012/extra --mode apply
terragucci respond tips --mode apply
terragucci respond fmt --branch my-change --mode apply
terragucci respond publish --module modules/network
terragucci respond version-bump --module modules/network --mode apply
```

`--json` prints one envelope, as every other command does.

### Version bump

Conventional commits decide a module's bump, and a `version` file in the module overrides it. `version-bump: suggest` adds one case: when none of the commits since the module's last release carries a conventional type, the typed-decision service reads the commit messages and a summary of the module's diff, and picks major, minor or patch. This needs [`decide`](/terragucci/reference/config/) in `terragucci.yml`. A project with only conventional commits never calls the service.

A module is released from its git tags (`<module>/v1.2.0`). A project that publishes to a registry alone has none, and gives `--since <ref>` instead: changes are counted from that ref, and the module's `version` file at the ref is the last release (0.0.0 when there was none). A module that has tags uses them.

The suggestion goes into a release pull request that writes the module's `version` file. The pull request body shows the bump with the probability the service gave it. Merging it confirms the version, and the next `tf-publish` run publishes it. Nothing publishes before that. When the probability is below the threshold, or the service is off or unreachable, the pull request proposes a patch and says why. The last release is read from the module's git tags.

### Drift attribution

With `respond.drift: attribute`, each drifted attribute is attributed before the pull request is written. The first of three steps that answers ends the question for that attribute.

1. A table of writes that a controller or a service makes by design. It holds an ECS service's task count, an autoscaling group's desired capacity, a node group's desired size and a provisioned DynamoDB table's capacity. It also holds RDS minor engine upgrades and tags in a service's own namespace, such as `aws:` and `karpenter.sh/`.
2. The cloud audit log. For `aws_` resources terragucci reads CloudTrail's LookupEvents with the `aws` CLI and the job's own credentials, over the last 14 days. The newest write that Terraform did not make decides. An AWS service principal is a controller. An IAM user, the root user or an Identity Center session is a person. A role session with a machine name answers nothing. A log that cannot be read is reported as "audit log unavailable" and the run goes on. The region comes from `audit_region` in `terragucci.yml`, and from the `aws` CLI's own settings when that is not set.
3. A typed decision, when `decide` is set and the first two steps are silent for that attribute. It picks controller write, human edit or provider default change. An answer below the `choice` threshold leaves the attribute unattributed. The model reads numbers and booleans as they are and every other value by its shape. A value the plan marks sensitive is never shown.

The answer picks the response. A controller write is reported with a suggested `lifecycle { ignore_changes = [...] }` and left out of the pull request. A provider default change is reported with a suggestion to pin the provider version or set the value, and also left out. A human edit stays in the codify pull request with the actor named when the audit log gave one, so the owner can accept or revert it. An unattributed attribute gets the default response. Nothing here applies or merges anything, and nothing changes state.

### Wave refused

An approval binds a wave's set digest. When a root's plan changes after the approval, the wave applies nothing. The diff reads the report the approval was given on and the current one. A waiting wave keeps the first on the `chant/lifecycle` branch next to its pending gate record, and the refused apply job writes both to `terragucci-report/approved` and `terragucci-report/current` before it runs this response. It lists each root whose plan digest moved and the changes and attributes that moved inside it. Approve again only once the new plan is the one you want.

### Apply failed

The triage table knows these classes of provider error:

| Class | Matches | Likely fix |
|---|---|---|
| access denied | `AccessDenied`, `AccessDeniedException`, `UnauthorizedOperation` | grant the permission the message names to the apply role |
| quota | `VpcLimitExceeded`, `LimitExceeded`, `TooManyBuckets`, `ServiceQuotaExceededException` | raise the quota or remove unused resources |
| throttling | `Throttling`, `ThrottlingException`, `RequestLimitExceeded` | run again; lower `-parallelism` if it repeats |
| already exists | `EntityAlreadyExists`, `ResourceAlreadyExistsException`, `BucketAlreadyOwnedByYou`, `InvalidGroup.Duplicate`, `QueueAlreadyExists` | import it, or give it another name |
| dependency | `DependencyViolation`, `DeleteConflict`, `BucketNotEmpty` | remove what depends on it first |
| state lock | `Error acquiring the state lock` | wait; a person runs `force-unlock` if no run holds it |

Each error is read from the log with the resource it is about. An error the table does not know is listed as unknown.

### Drift

A refresh-only plan of each root finds what changed. Where the changed attribute is a literal in the root's own resource block, the pull request writes the live value there. Merging it accepts the change made outside Terraform, so read it first.

Some changes are only reported, each with its reason:

| The value | Why it stays |
|---|---|
| set from a variable or an expression | the literal to change is elsewhere |
| set inside a module | the module serves other roots too |
| on a `count` or `for_each` instance | one literal sets every instance |
| never set in the root | it comes from a default |
| on a resource deleted outside Terraform | the next apply makes it again |

For a resource the state does not hold, pass `--import <address>=<id>`. terragucci writes the import block, and `plan -generate-config-out` writes its config. On Terraform 1.14 and later, a root with a `.tfquery.hcl` file gets both from `terraform query`.

### Description check

With `respond.description: check` and a [`decide` block](/terragucci/reference/config/#the-decide-block), the plan job asks the decision service one yes-or-no question before it posts the note: does the pull request's title and description describe what the plan does? The service reads the title, the description and the redacted report's summary (counts by action, the named destroys and replacements, the groups). When it answers yes with a probability at or above the threshold, the note starts with a line asking the author to check the description and naming the destroys and replacements the text does not mention. The same line sits at the top of `report.html`, and `intent.json` in the report directory records the decision, its probability and the model.

Below the threshold, with no `decide` block, or with a service that does not answer, the note is the one it would be without the check, and `intent.json` says why. The flag never blocks a merge and changes no gate, digest or group. The title and description come from the job's event, so a re-plan started by a comment is not checked.

```bash
terragucci respond description --report terragucci-report --title "retag email" --description "Tags only." --mode apply
```

### Tips, fmt and release notes

Each tip is its own pull request.

| Tip | The pull request |
|---|---|
| a provider taken by a range | pins it in `required_providers` at the version the lock file holds, so the next plan changes nothing |
| a root with no lock file | adds one written by `providers lock`, with hashes for Linux and macOS on amd64 and arm64 unless `--platform` names others |
| no canary | adds `waves.canary` |

`fmt` runs on request. It formats the pull request's branch and pushes one commit there, and it refuses the default branch.

Release notes cover the commits that touched a module between its last two tags. Breaking changes are listed first.

## Where it runs

The responses are terragucci commands, so they run wherever the stages run: forge CI by default, or a fountain steward. Neither needs a model.

A model runs only for events set to `agent`, in the integration you name: a forge job or fountain's agent sandbox. It holds the integration's token and at most a read-only role. It never holds an apply role or a gate's signing key.

## Agent recipes

A response set to `agent` also writes `terragucci-respond/<event>.json`. The file holds the deterministic result and the integration. It also lists what the agent may do and what it never does:

| May | Never |
|---|---|
| comment | approve, apply or merge |
| open a pull request for a person to review | re-approve a gate or push to the default branch |
| | run `state rm`, `import` or `force-unlock` |

A forge recipe adds one job after the plan job. The job reads the plan report and runs the response. It then hands the file to the model. On GitHub, with the Claude Code action:

```yaml
explain:
  needs: plan
  if: always()
  runs-on: ubuntu-latest
  permissions:
    contents: read
    pull-requests: write
  steps:
    - uses: actions/checkout@v4
    - uses: actions/download-artifact@v4
      with: { name: terragucci-report, path: terragucci-report }
    - run: npx -y @intentius/terragucci respond plan --report terragucci-report
    - uses: anthropics/claude-code-action@v1
      with:
        anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
        github_token: ${{ secrets.AGENT_FORGE_TOKEN }}
        prompt: |
          Read terragucci-respond/plan.json. Explain the grouped summary and each
          destroy in plain words, as one comment on this pull request.
          Do only what its agent.may list allows.
```

The job's token can comment and nothing more. Any tool that reads JSON and comments through the forge API can take the file instead. On fountain, a fountain Agent takes the file and drafts the comment for a person to review.
