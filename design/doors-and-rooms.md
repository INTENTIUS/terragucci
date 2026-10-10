# Doors and rooms (design)

Status: built in #838. This file records why the site is laid out this way, so the decision can be revisited. The audit that led to it, with the personas, journeys and a mock of the picker, is at https://claude.ai/artifact/RgAoHW3qdTxomkdjni5feh (its coverage grids were rough counts; the site's grids replace them).

## Problem

terragucci runs on three forges, three binaries and five repo shapes, and replaces a dozen other tools. Before #838 the home page named three of the shapes, the "Start from what you want" cards sat about twelve screens down, the hosted-platform card sent Spacelift users to the HCP page, and coverage was a 315-row table of claim names. Each community had to dig for its own way in, and nothing said what terragucci does not do.

## Decision

Two layers.

| Layer | Picks by | Lives in |
|---|---|---|
| Door | who you are, what you run, where, and what you are leaving | the picker on the home page (`DoorPicker.astro`), the role doors under it, the "Rooms" and "Coming from" sidebar groups |
| Room | one community's page: what works, what differs, the first step, what you can count on, then how-to, explanation and reference | `rooms/*.mdx`, each one `Room.astro` over `src/data/rooms.ts` |

Diataxis decides the order inside a room (task, then explanation, then reference). It does not decide the doors: it sorts pages by the reader's mode, not by what they run, and the site's problem was the second.

Reassurance comes from stating limits with their reason, next to the pick that hits them, rather than from a list of logos. The picker's "Differs" column and the home page's Limits table carry them.

One data file, `docs-site/src/data/rooms.ts`, feeds the picker, the rooms and the Limits table, so they cannot disagree.

## Personas and what they rank first

| Persona | First concern | Door |
|---|---|---|
| Platform engineer | does it handle many roots safely: waves, gates, locks | repo shape picker, many repos |
| App developer | a plan note on my pull request with nothing new to learn | getting started |
| Security reviewer | what each job can reach, who approves, the record | I review security |
| Buyer or evaluator | what it proves, what it costs, what it leaves out | I am evaluating, Proof |
| Atlantis, OpenTaco or Terrateam user | my comment workflow keeps working | coming from |
| HCP, Scalr, OTF, Spacelift or env zero user | state and policy move over | coming from |
| Terragrunt, Atmos, Terramate or CDK Terrain user | my repo shape is understood, not flattened | repo shape picker |
| choudoufu user | what the fork adds | binary picker, choudoufu room |
| Team with coding agents | what the agent may do, and that it never applies | I work with a coding agent |

## Assumed features

Nobody chooses a tool for these, and anyone loses trust if one is missing or buried. Every room lists them under "You can count on" (`ASSUMED` in `rooms.ts`): plan note per pull request, gated apply, locks and staleness, re-plan by comment, drift, OIDC, policy, audit trail, secrets out of logs, your state backend, your runners, forge sign-in.

## Coverage

The validation page leads with two grids (area by tool, area by forge) over `smoke.json` and `validation.json`, with the full tables below. Every check runs on OpenTofu on Forgejo. Runs on Terraform, choudoufu and github.com are expensive, so they re-run only the checks where the binary or forge changes what happens; a cell for a binary-independent area says "same code on every binary" instead of looking like a gap.

## Rejected

| Option | Why not |
|---|---|
| Diataxis as the top-level navigation | it answers "what mode am I in", not "is this for my stack" |
| One page per tool and forge combination | 45 pages that mostly repeat; the picker composes shape, binary and forge notes instead |
| Hiding the short Terraform and choudoufu columns | the reason is cost and it is true; a blank cell read as unsupported |
| A room per forge | forge differences are a few lines; they show in the picker and in each shape room |

## Revisit when

- a new repo shape, binary or forge is supported: add it to `rooms.ts`, and the picker and rooms follow;
- analytics show readers leaving the home page without picking;
- a room's "Differs" list grows past a handful of lines, which suggests a how-to is missing.
