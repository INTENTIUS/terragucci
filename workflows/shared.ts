/**
 * Pins both declared workflows share.
 *
 * ci/pipeline.ts and pages/pipeline.ts are separate chant build roots, because
 * `chant build <dir>` collects a directory into one output file and two
 * workflows are two files. The pins live here so the two cannot disagree.
 *
 * This directory is not a build root. Its exports are functions and strings,
 * not Declarables, so a stray build picks up nothing from it.
 */

import { Step } from "@intentius/chant-lexicon-github";

/**
 * Actions by commit SHA, with the tag each resolved from in the comment.
 * chant's github lint asks for that comment in the YAML too; the lexicon's
 * `pin: "sha"` option writes it, and replaces these two constants, once a
 * chant release carries it (#2621).
 */
export const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"; // v7.0.1

export const SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"; // v7.0.0

export const UPLOAD_ARTIFACT = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"; // v7.0.1

export const NODE_VERSION = "24";

/**
 * The npm the publish workflow installs when the Node it gets bundles an older
 * one. npm's trusted publishing needs 11.5.1 or later; Node 24.21.0 bundles
 * 11.19.0, so on a current Node 24 the install is skipped.
 */
export const NPM_VERSION = "11.19.0";

export const NPM_TRUSTED_PUBLISHING_MIN = "11.5.1";

export const JUST_VERSION = "1.36.0";

/**
 * `just` is the documented interface, so CI runs the same targets a person
 * does. A pinned release binary, not an install script that resolves to
 * whatever upstream published that day.
 */
export const installJust = (): InstanceType<typeof Step> =>
  new Step({
    name: "Install just",
    run: [
      // x86_64 or aarch64, so the step works on GitHub's arm64 runners too.
      `curl -fsSL -o /tmp/just.tar.gz https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz`,
      `tar -xzf /tmp/just.tar.gz -C /tmp just`,
      `sudo mv /tmp/just /usr/local/bin/just`,
      `just --version`,
    ].join("\n"),
  });

export const ACT_VERSION = "0.2.89";

/** `act` runs the github profile's workflows on the runner; a pinned release binary. */
export const installAct = (): InstanceType<typeof Step> =>
  new Step({
    name: "Install act",
    run: [
      `arch=$(uname -m); [ "$arch" = aarch64 ] && arch=arm64`,
      `curl -fsSL -o /tmp/act.tar.gz https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_$arch.tar.gz`,
      `tar -xzf /tmp/act.tar.gz -C /tmp act`,
      `sudo mv /tmp/act /usr/local/bin/act`,
      `act --version`,
    ].join("\n"),
  });

/**
 * OpenTofu at the version the tofu image carries, for the tests that run the
 * real binary (they skip where `tofu` is missing, so the check job installs
 * it: a laptop has it, a fresh runner does not).
 */
export const installTofu = (version: string): InstanceType<typeof Step> =>
  new Step({
    name: "Install OpenTofu",
    run: [
      `arch=$(uname -m); case "$arch" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac`,
      `curl -fsSL -o /tmp/tofu.tar.gz https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_linux_$arch.tar.gz`,
      `tar -xzf /tmp/tofu.tar.gz -C /tmp tofu`,
      `sudo mv /tmp/tofu /usr/local/bin/tofu`,
      `tofu version`,
    ].join("\n"),
  });
