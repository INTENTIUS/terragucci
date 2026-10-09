import { ApplyOp } from "@intentius/chant/op";

// terragucci's wave gate is the approval, so the Op declares none of its own.
const { op } = ApplyOp({ name: "schema-apply", env: "prod", target: "postgres" });

export default op;
