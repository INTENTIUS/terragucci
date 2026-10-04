---
title: Approve a waiting wave
description: Read what a wave will do, record your approval, and let the apply carry on.
---

## What you end up with

One wave applied, with an approval recorded in your repo that names the exact plans you read.

## Before you start

- A merge that reached the default branch, so `tf-apply` has started.
- `gate` set to `on-destroy` (the default) or `always`. With `never`, no wave waits. [Gate policy](/terragucci/reference/stages/#gate-policy) lists the three.
- chant installed where you approve: `npm i -D @intentius/chant`.
- Write access to the repo. The approval is a commit on its `chant/lifecycle` branch.
- An ssh key of yours listed in `.chant/allowed_signers` on the default branch. [Set up the signers file](#set-up-the-signers-file) once per repo.
- You are a person. Approvals belong to people, so an agent or a script that approves on your behalf defeats the gate.

## Steps

### 1. Find the waiting wave

After a merge, the apply job applies each wave in turn. A wave that needs an approval stops the job with exit code 3 and prints the command to run. The pull request's plan note shows the same command at its foot, for example:

```text
approve wave 2 with chant approve tf-apply wave-2 --sign
```

Open the wave's roots in the report linked from the run. The report lists the wave's set digest and the approval state of each wave.

### 2. Read what the wave will do

The wave waits because its plans destroy something, or because `gate` is `always`. Read every destroy and replacement by name. They are never folded into a group, so they sit at the top of the report. Open a root's full plan when you need the detail.

### 3. Approve it

```bash
npx chant approve tf-apply wave-2 --actor github:alice --sign ~/.ssh/id_ed25519
```

`--actor` is you, named as the signers file names you. `--sign` seals the approval with your key. With no key file, it uses git's `user.signingkey` when `gpg.format` is `ssh`.

The command writes a record to the `chant/lifecycle` branch. The record names the wave's set digest, a hash over the plan digest of every root in it. The approval covers those plans and no others, and the seal covers the record: an edited record no longer verifies.

`terragucci init` lists every wave's gate under `identity.gates` in `chant.workspace.json`, so the apply job counts an approval only when its seal verifies against `.chant/allowed_signers` as the default branch holds it. An unsigned approval, or one sealed with a key the file does not list for its approver, does not let the wave apply. The job prints why the approval does not count.

### 4. Run the stage again

Re-run the apply job from your forge, or push to the default branch. The stage finds the approval and applies the wave. It starts from where it stopped and never applies a root twice. If a later wave also needs an approval, the job stops again at exit code 3 with the next command.

The report now links each wave to its approval record.

## Set up the signers file

Once per repo, through a reviewed pull request to the default branch:

1. Add `.chant/allowed_signers`, one line per person who approves, in ssh-keygen's allowed_signers format:

   ```text
   github:alice ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...
   github:bob ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ...
   ```

   The apply job checks Ed25519 keys, Ed25519 security keys (`sk-ssh-ed25519@openssh.com`) and RSA keys. A line with `valid-after`, `valid-before` or `cert-authority`, or a principal pattern, is ignored.

2. Never list an agent's key, a CI job's key or a bot's key. The file says who may approve, and approvals belong to people.

3. Protect the `chant/lifecycle` branch so that only the apply job's identity can push to it, and block force pushes and deletion. The apply job writes the pending records there. A seal stops a forged approval from counting, and branch protection stops the records from being rewritten or removed.

The signers file and `chant.workspace.json` are read from the default branch, so a pull request cannot loosen the rule that judges it.

## If the wave refuses instead

When any root's plan changed after you approved, the wave applies nothing. [Fix a refused wave](/terragucci/guides/fix-a-refused-wave/) covers that.

## Next

- [How waves and approvals work](/terragucci/concepts/waves-and-approvals/)
- [Approvals as records in your repo](/terragucci/concepts/approvals-as-records/)
