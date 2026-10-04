---
title: Have an agent propose drift fixes
description: Hand drift the default response cannot fix to an agent, which opens a pull request for a person to review.
---

## What you end up with

A pull request for each drift the deterministic response only reports: values set through variables, modules or expressions. A person reviews it like any other.

It never approves, applies or merges, and never pushes to the default branch.

## Before you start

- [Turn on drift checks](/terragucci/guides/turn-on-drift-checks/).
- An API key for the model, and a forge token that can push a branch and open a pull request but cannot merge or approve.
- A read-only plan role if it reads the cloud. The apply role is refused.

## Steps

### 1. See what the default fixes

```bash
npx terragucci respond drift
```

A dry run prints the pull request it would open. Where the changed attribute is a literal in the root's own resource block, the pull request writes the live value there. Other drift is only reported, each with its reason. Those are the cases an agent can take.

### 2. Turn the event over to an agent

```yaml
respond:
  drift: agent
agent:
  via: forge
  token_env: AGENT_FORGE_TOKEN
```

The default still runs first. The agent adds a proposal for the rest.

### 3. Check the file

```bash
npx terragucci config check
```

```text
terragucci.yml: ok
```

### 4. Add the job after the drift job

The job runs `respond drift`, which writes `terragucci-respond/drift.json`, then hands that file to the agent as in [Have an agent explain a plan](/terragucci/guides/agent-explain-a-plan/). Ask for one pull request per root that changes Terraform code only and describes the drift it saw. The file's never list forbids `state rm`, `import` and `force-unlock`.

For a resource the state does not hold, `terragucci respond drift --root <root> --import <address>=<id> --mode apply` writes the import block with no model, and `plan -generate-config-out` writes its config.

### 5. Review the pull request

Read the diff against the live value. Merging accepts a change made outside Terraform, so merge only what you want to keep. The usual plan and apply stages then run on it.

## Next

- [Responses to pipeline events](/terragucci/reference/responses/#drift)
- [Move apply onto a fountain steward](/terragucci/guides/move-apply-to-fountain/) if the agent should run in fountain's sandbox.
