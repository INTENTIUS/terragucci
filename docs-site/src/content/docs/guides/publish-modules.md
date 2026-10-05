---
title: Publish your modules
description: Version the modules beside your roots automatically, as OCI artifacts or git tags, on every merge.
---

## What you end up with

Every module that changed on the default branch released under a new number, each with a digest your roots can pin.

## Before you start

- Modules in one place, such as `modules/network` and `modules/service`.
- Conventional commit messages, which decide the version bump.
- An OCI registry, or permission to push git tags to `origin`. OpenTofu roots pin the OCI artifact. Terraform has no OCI sources, so its roots pin a git tag per module.

## Steps

### 1. Name the modules and where they go

Put it in `terragucci.yml`.

```yaml
modules:
  path: modules/*
  publish: oci://registry.example.com/acme/modules
```

`publish` takes an `oci://` registry address, `git-tags`, or a list of both.

### 2. Preview

```bash
npx terragucci publish --dry-run
```

It lists each module whose content differs from its last release, with the version it would publish. The next version follows the commits since that release that touched the module: `feat` is a minor bump and `fix` or any other type is a patch. A breaking marker (`feat!:` or a `BREAKING CHANGE:` footer) is a major. A module with no release yet starts at `0.1.0`.

A `version` file in the module directory overrides the bump. When a module's commits have no conventional type, `respond.version-bump: suggest` opens a release pull request with a suggested bump and its probability; see [Responses to pipeline events](/terragucci/reference/responses/#version-bump). Once that version is published, change the file to publish the next content.

### 3. Add the publish job

```bash
npx terragucci init
```

With `modules.publish` set, the pipeline gets a `publish` job. It runs after `apply` on a push to the default branch, with the full history.

### 4. Give it registry credentials

The publish job is the only job given these variables. Set them as secrets on GitHub and Forgejo, and as protected, masked variables on GitLab:

| Variable | Holds |
|---|---|
| `TERRAGUCCI_REGISTRY_USER` | the registry user |
| `TERRAGUCCI_REGISTRY_PASSWORD` | its password or token |
| `TERRAGUCCI_REGISTRY_INSECURE` | `1` for a registry without TLS |

Git tags need no credentials of their own. They are pushed to `origin`, so the job checks out the full history.

### 5. Merge a change to a module

On the next push to the default branch, the job publishes. The OCI manifest digest prints with each version, and a root can pin it: `oci://registry.example.com/acme/modules/network@sha256:...`.

A published version never changes. Each release records the commit it was cut from and a digest of the module's content, so a second run on the same commit publishes nothing, and so does a change that was reverted. Before choosing a version, git-tag publishing fetches the module's tags from `origin`. A version that `origin` already holds with the same content is reported as unchanged. When the content differs, the run stops and names the tag.

## Next

- [Roll out a new module version](/terragucci/guides/roll-out-a-module-version/) moves your roots onto it.
- [Environment variables and credentials](/terragucci/reference/environment/)
