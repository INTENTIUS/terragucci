/**
 * What the bundle gives the MCP SDK in place of its Ajv validator
 * (scripts/cli-bundle.mjs points `validation/ajv-provider.js` here). The SDK
 * validates JSON Schema only for what a server asks a client to fill in
 * (elicitation), and `terragucci mcp` asks for nothing, so Ajv, a fifth of
 * the SDK's size, stays out of the bundle. A schema it is ever handed is
 * refused, never passed unchecked.
 */
export class AjvJsonSchemaValidator {
  getValidator<T>(_schema: unknown): (input: unknown) => { valid: false; data: undefined; errorMessage: string } | { valid: true; data: T; errorMessage: undefined } {
    return () => ({ valid: false, data: undefined, errorMessage: "terragucci mcp asks a client for no input, so it validates none" });
  }
}
