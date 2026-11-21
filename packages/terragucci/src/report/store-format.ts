/**
 * The report store's documents in chant's format (`@intentius/chant/report-store`):
 * a stage's report.json and a commit's run.json as `chant.run/v1`,
 * estate.json as `chant.estate/v1` and dora.json as `chant.dora/v1`, each
 * with `product: "terragucci"` after `schema` and the body as terragucci
 * writes it under its own id. audit.jsonl's lines in that format are
 * `chant.audit/v1` (./audit.ts).
 *
 * terragucci writes its own ids (`terragucci.report/v1`, `terragucci.run/v1`,
 * `terragucci.estate/v1`, `terragucci.dora/v1`, `terragucci.audit/v1`) and
 * reads both forms: {@link isOwn} takes either. A neutral document of another
 * product is not terragucci's. index.json is `terragucci.report-index/v1`.
 */
import { neutralReport, REPORT_SCHEMAS, type ReportKind } from "@intentius/chant/report-store";

/** The product a neutral document terragucci writes names. */
export const STORE_PRODUCT = "terragucci";

/** The neutral id and product a document in the store carries. */
export interface StoreHead<K extends ReportKind> {
  schema: (typeof REPORT_SCHEMAS)[K];
  product: typeof STORE_PRODUCT;
}

/** The head a document of `kind` is written with. */
export const storeHead = <K extends ReportKind>(kind: K): StoreHead<K> => ({ schema: REPORT_SCHEMAS[kind], product: STORE_PRODUCT });

/** `doc` under chant's neutral id of `kind`, with `product: "terragucci"`; the body as it is. */
export function storedDoc<T extends { schema: string }>(doc: T, kind: ReportKind): Omit<T, "schema"> & StoreHead<typeof kind> {
  return neutralReport(doc, kind, STORE_PRODUCT) as unknown as Omit<T, "schema"> & StoreHead<typeof kind>;
}

/** Whether a document is terragucci's of `kind`: chant's neutral id naming terragucci, or `own`, the id older releases wrote. */
export function isOwn(doc: unknown, kind: ReportKind, own: string): boolean {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as { schema?: unknown; product?: unknown };
  return d.schema === own || (d.schema === REPORT_SCHEMAS[kind] && d.product === STORE_PRODUCT);
}
