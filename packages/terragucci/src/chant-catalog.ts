/**
 * chant's release catalog and the terraform lexicon's registry catalog parts,
 * imported directly: the pin (0.124.55) carries both. The shapes are the
 * looser interfaces in ./chant-next.ts, which the rest of terragucci is typed against.
 */
import * as changelog from "@intentius/chant/lifecycle/release-changelog";
import * as status from "@intentius/chant/lifecycle/release-status";
import * as site from "@intentius/chant/lifecycle/release-catalog-site";
import * as model from "@intentius/chant/lifecycle/release-catalog";
import * as registry from "@intentius/chant-lexicon-terraform/registry";
import type { ChantRegistryCatalog, ChantReleaseCatalog } from "./chant-next";

/** Core's release catalog model, site, status records and changelog (chant#4595 to #4597). */
export const releaseCatalog = { ...changelog, ...status, ...site, ...model } as unknown as ChantReleaseCatalog;

/** The terraform lexicon's docs extractor, consumer scan, catalog reader and deprecated-version check (chant#4598, #4599). */
export const registryCatalog = registry as unknown as ChantRegistryCatalog;
