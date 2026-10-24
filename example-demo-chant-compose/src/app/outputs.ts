/** What `app` publishes: the port it listens on, which edge routes to. */
import { output, Ref } from "@intentius/chant-lexicon-aws";
import { appHttpProxyPort } from "./params";

export const appListenerPort = output(Ref(appHttpProxyPort), "ListenerPort");
