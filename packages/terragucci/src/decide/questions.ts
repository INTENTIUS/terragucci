/**
 * The questions terragucci's three typed-decision uses ask (terragucci#28).
 * Each use builds its own state from the redacted report or the commits, asks
 * its question through `decide`, and acts only on a confident answer. These
 * are the starting wording; a use may refine its own question.
 */
import type { ChoiceQuestion, NoulQuestion } from "./index";

/**
 * #30: does a pull request's title and description leave out what its plan
 * does? State: the title, the description, and the redacted report's summary
 * (counts by action, named destroys and replacements, groups).
 */
export const PR_INTENT: NoulQuestion = {
  type: "noul",
  instructions:
    "Read the pull request's title and description, then the summary of what its plan does. " +
    "Does the description leave out or misstate a destroy or a replacement the plan makes?",
  criteria: {
    true: "the description does not describe the plan: a destroy or replacement in the plan is missing from it or contradicted by it",
    false: "the description describes what the plan does, including every destroy and replacement",
  },
};

/**
 * #31: who changed a drifted attribute, asked only when the known-defaults
 * table and the cloud audit log have both said nothing. State: the resource
 * type, the attribute, the value in code and the live value.
 */
export const DRIFT_ACTOR: ChoiceQuestion = {
  type: "choice",
  instructions:
    "An attribute of a resource managed by Terraform changed outside Terraform. " +
    "From the resource, the attribute and the two values, which kind of change is it most likely?",
  criteria: {
    controller: "a controller or the cloud service wrote it, as autoscaling, a scheduler or a service that adds tags does",
    human: "a person edited it by hand in a console or with a CLI",
    "provider-default": "the provider or the cloud API changed a default value it reports",
  },
};

/**
 * #32: the release a module's change calls for, asked only when none of the
 * commits since the last release carries a conventional type. State: the
 * commit messages and the module's diff summary.
 */
export const VERSION_BUMP: ChoiceQuestion = {
  type: "choice",
  instructions:
    "These are the commits to a Terraform module since its last release, and a summary of its diff. " +
    "Which semantic version bump does the change call for?",
  criteria: {
    major: "a breaking change: a variable or output removed or renamed, a required variable added, or a resource replaced for every caller",
    minor: "a new feature that keeps every existing caller working, such as a new optional variable, output or resource",
    patch: "a fix or an internal change that callers do not see",
  },
};

export const QUESTIONS = { prIntent: PR_INTENT, driftActor: DRIFT_ACTOR, versionBump: VERSION_BUMP } as const;
