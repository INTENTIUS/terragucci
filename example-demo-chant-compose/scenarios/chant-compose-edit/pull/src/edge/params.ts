/** app's ListenerPort output, declared as a parameter of the `edge` stack (edge.component.ts fills it). */
import { Parameter } from "@intentius/chant-lexicon-aws";

export const edgeListenerPort = new Parameter("String", {
  description: "The app stack's ListenerPort output",
});

/** app's AdminListenerPort output, declared as a parameter of the `edge` stack. */
export const edgeAdminListenerPort = new Parameter("String", {
  description: "The app stack's AdminListenerPort output",
});
