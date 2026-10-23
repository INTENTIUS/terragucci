/**
 * What `lifecyclePrEnvPorts` in chant's pr-env-run.ts imports to decide the
 * gate (`./pr-run` and `../op/gate`), as the CLI bundle resolves it
 * (scripts/cli-bundle.mjs). terragucci never calls those ports: its
 * ephemeral environments pass their own (ephemeral.ts `ports`), which decide
 * the gate from the ledger with terragucci's own code. Those two modules
 * bring Ajv, js-yaml and chant's component driver with them, so they stay
 * out of the bundle, and a call that reaches here throws.
 */
const refused = (): never => {
  throw new Error("terragucci decides a pull request environment's gate with its own ports, so chant's lifecycle ports are not in this bundle");
};

export const approvalOf = refused;
export const decidePrGate = refused;
export const readOnlyLedger = refused;
export const gitGateLedgerPort = refused;
