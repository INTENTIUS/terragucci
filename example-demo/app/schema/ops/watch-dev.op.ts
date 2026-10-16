import { WatchOp } from "@intentius/chant/op";

// Every hour at :17, read dev and report drift: a declared object changed out
// of band, or gone. Objects src/ does not declare are never reported.
// `chant run watch-dev` runs it once, by hand.
export const { op: watchDev } = WatchOp({ name: "watch-dev", env: "dev", schedule: "17 * * * *" });
