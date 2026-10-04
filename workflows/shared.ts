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

export const NODE_VERSION = "24";

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
