/** What `app` publishes: the ports it listens on, which edge routes to. */
import { output, Ref } from "@intentius/chant-lexicon-aws";
import { appAdminPort, appHttpProxyPort } from "./params";

export const appListenerPort = output(Ref(appHttpProxyPort), "ListenerPort");
export const appAdminListenerPort = output(Ref(appAdminPort), "AdminListenerPort");
