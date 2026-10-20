/**
 * Hold JSON to one of the package's JSON Schemas (report, report-index,
 * estate, audit). The tests use `validate`; a smoke claim runs it on what a
 * run wrote to the bucket:
 *
 *   npx tsx scripts/schema-check.ts <schema.json> <file.json>...
 *   npx tsx scripts/schema-check.ts --lines <schema.json> <file.jsonl>...
 *
 * It knows the keywords the schemas use (KEYWORDS) and no others, and reads
 * an object with `properties` and no `additionalProperties` as closed: a field
 * the writer adds and the schema lacks fails here. A reader using a full
 * validator gets the open reading JSON Schema gives, which is what lets a
 * minor version add fields.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

/** Every keyword `validate` reads or may skip; `unknownKeywords` names any other a schema uses. */
export const KEYWORDS = new Set(["$schema", "$id", "$ref", "$defs", "title", "description", "type", "const", "enum", "required", "properties", "additionalProperties", "items", "minimum"]);

/** The keywords a schema uses that `validate` does not know, by where they are. */
export function unknownKeywords(schema: unknown, at = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(schema as Json)) {
    if (!KEYWORDS.has(k)) out.push(`${at}.${k}`);
    if (k === "properties" || k === "$defs") for (const [name, sub] of Object.entries(v as Json)) out.push(...unknownKeywords(sub, `${at}.${k}.${name}`));
    else if (k === "items" || k === "additionalProperties") out.push(...unknownKeywords(v, `${at}.${k}`));
  }
  return out;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** The ways `value` breaks `schema`, each with its JSON path; empty when it holds. */
export function validate(schema: Json, value: unknown, at = "$", root: Json = schema): string[] {
  if (typeof schema.$ref === "string") return validate(root.$defs[(schema.$ref as string).split("/").pop()!], value, at, root);
  const errs: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((t: string) => t === typeOf(value) || (t === "number" && typeof value === "number"))) return [`${at}: ${typeOf(value)} is not ${types.join("|")}`];
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${at}: not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) errs.push(`${at}: ${value} is below ${schema.minimum}`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in (value as Json))) errs.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value as Json)) {
      const sub = schema.properties?.[k] ?? schema.additionalProperties;
      if (sub && typeof sub === "object") errs.push(...validate(sub, v, `${at}.${k}`, root));
      else if (schema.properties && !schema.additionalProperties) errs.push(`${at}: ${k} is not in the schema`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`, root)));
  return errs;
}

function main(argv: string[]): number {
  const lines = argv[0] === "--lines";
  const [schemaPath, ...files] = lines ? argv.slice(1) : argv;
  if (!schemaPath || files.length === 0) {
    console.error("usage: schema-check.ts [--lines] <schema.json> <file>...");
    return 2;
  }
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as Json;
  let bad = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const docs = lines ? text.split("\n").filter((l) => l.trim()) : [text];
    docs.forEach((doc, i) => {
      const where = lines ? `${file}:${i + 1}` : file;
      let errs: string[];
      try {
        errs = validate(schema, JSON.parse(doc));
      } catch (e) {
        errs = [`not JSON: ${(e as Error).message}`];
      }
      for (const e of errs) console.error(`${where}: ${e}`);
      if (errs.length) bad++;
      else console.log(`${where}: ${schema.title}`);
    });
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
