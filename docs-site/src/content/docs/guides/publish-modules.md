---
title: Publish your modules
description: Version the modules beside your roots automatically, as OCI artifacts or git tags, on every merge.
claims: [publish, version-bump-job]
---

## What you end up with

Every module that changed on the default branch released under a new number, each with a digest your roots can pin.

## Before you start

- Modules in one place, such as `modules/network` and `modules/service`.
- Conventional commit messages, which decide the version bump.
- An OCI registry, or permission to push git tags to `origin`. Terraform has no OCI sources, so its roots pin a git tag.

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

It lists each changed module with its next version: `feat` is minor, anything else patch, `feat!:` or a `BREAKING CHANGE:` footer major. A first release is `0.1.0`.

A `version` file in the module directory overrides the bump; change it after publishing to release the next content. For commits with no conventional type, see [`respond.version-bump`](/terragucci/reference/responses/#version-bump).

### 3. Add the publish job

```bash
npx terragucci init
```

This adds a `publish` job that runs after `apply` on a push to the default branch, with full history.

### 4. Give it registry credentials

Only the publish job gets these. Set them as secrets on GitHub and Forgejo, protected masked variables on GitLab:

| Variable | Holds |
|---|---|
| `TERRAGUCCI_REGISTRY_USER` | the registry user |
| `TERRAGUCCI_REGISTRY_PASSWORD` | its password or token |
| `TERRAGUCCI_REGISTRY_INSECURE` | `1` for a registry without TLS |

Git tags need no credentials; they are pushed to `origin`.

### 5. Merge a change to a module

The next push to the default branch publishes. The OCI manifest digest prints with each version, and a root can pin it: `oci://registry.example.com/acme/modules/network@sha256:...`.

A published version never changes, so a rerun publishes nothing. Git-tag publishing fetches `origin`'s tags first; the same content is unchanged, different content stops the run and names the tag.

## Next

- [Roll out a new module version](/terragucci/guides/roll-out-a-module-version/) moves your roots onto it.
- [Environment variables and credentials](/terragucci/reference/environment/)
