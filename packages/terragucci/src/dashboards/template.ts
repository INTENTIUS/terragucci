/**
 * The dashboards and rules as data, so the bundle carries the rendered files
 * and not the grafana, prometheus and otel lexicons, js-yaml and the PromQL
 * parser that render them (terragucci#163).
 *
 * scripts/render-dashboards.ts renders the declarations (index.ts) with a
 * placeholder for each value terragucci.yml sets, once with a reports address
 * and once without, and writes the result to rendered.json. `init` fills the
 * placeholders with the repo's values (files.ts). The values are the
 * `dashboards:` settings (the datasource uids, the folder, the provisioning
 * path, the three durations and the seconds they come to) and the reports
 * address, which also decides whether the Runs and Estate dashboards link the
 * reports at all. The project, telemetry.trace_url and the rest of the config
 * do not reach the dashboards.
 *
 * A dashboard is kept as its JSON value and written with JSON.stringify, the
 * way the grafana lexicon writes it, so a value lands escaped as JSON would.
 * A YAML file is kept as its lines; a uid, folder or path there is a whole
 * scalar, written the way js-yaml's dump writes it (yamlScalar), and a
 * duration is a run of digits and letters that never needs quoting.
 *
 * This file imports nothing, so the generator and the tests can use it
 * without rendered.json.
 */
import type { DashboardSettings } from "../config";
import type { DashboardLinks, RenderedFile } from "./settings";

/** The values the declarations are rendered with, one per setting. */
export const PLACEHOLDERS = {
  dir: "TGPH0DIR",
  prometheus: "TGPH0PROMETHEUS",
  tempo: "TGPH0TEMPO",
  folder: "TGPH0FOLDER",
  path: "TGPH0PATH",
  drift_age: "7919001s",
  wave_wait: "7919002s",
  schedule: "7919003s",
} as const satisfies Required<DashboardSettings>;
/** The reports address the declarations are rendered with. */
export const REPORTS_PLACEHOLDER = "https://tgph0.invalid/TGPH0REPORTS";

const DURATION_KEYS = ["drift_age", "wave_wait", "schedule"] as const;
const TEXT_KEYS = ["prometheus", "tempo", "folder", "path"] as const;

/** One rendered file, under the settings' dir. `links` says which reports variant it is, when the two differ. */
export type TemplateFile = { path: string; links?: boolean } & ({ json: unknown; suffix: string } | { yaml: string[] });

export interface DashboardTemplate {
  note: string;
  files: TemplateFile[];
}

/** A Prometheus duration in seconds, as the prometheus lexicon's durationMs reads it; 0 when it is not one. */
export function durationSeconds(d: string): number {
  if (d === "0") return 0;
  const m = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(d);
  if (!d || !m) return 0;
  const unit = [365 * 86_400_000, 7 * 86_400_000, 86_400_000, 3_600_000, 60_000, 1_000, 1];
  let ms = 0;
  for (let i = 0; i < unit.length; i++) if (m[i + 1] !== undefined) ms += Number(m[i + 1]) * unit[i];
  return Math.round(ms / 1000);
}

/** The rendered files for two renders, with and without a reports address, kept as a template. */
export function buildTemplate(render: (settings: Required<DashboardSettings>, links: DashboardLinks) => RenderedFile[], note: string): DashboardTemplate {
  const prefix = `${PLACEHOLDERS.dir}/`;
  const strip = (files: RenderedFile[]) =>
    new Map(
      files.map((f) => {
        if (!f.path.startsWith(prefix)) throw new Error(`${f.path} is not under the dashboards dir`);
        return [f.path.slice(prefix.length), f.content];
      }),
    );
  const linked = strip(render({ ...PLACEHOLDERS }, { reports: REPORTS_PLACEHOLDER }));
  const plain = strip(render({ ...PLACEHOLDERS }, {}));
  if ([...linked.keys()].join() !== [...plain.keys()].join()) throw new Error("the dashboards differ in their files with and without a reports address");
  const entry = (path: string, content: string, links?: boolean): TemplateFile => {
    const at = links === undefined ? {} : { links };
    if (!path.endsWith(".json")) return { path, ...at, yaml: content.split("\n") };
    const json = JSON.parse(content) as unknown;
    const pretty = JSON.stringify(json, null, 2);
    if (!content.startsWith(pretty) || !/^\n?$/.test(content.slice(pretty.length))) throw new Error(`${path} is not JSON.stringify's output, so it cannot be kept as its value`);
    return { path, ...at, json, suffix: content.slice(pretty.length) };
  };
  const files: TemplateFile[] = [];
  for (const [path, content] of linked) {
    const other = plain.get(path)!;
    if (content === other) files.push(entry(path, content));
    else files.push(entry(path, content, true), entry(path, other, false));
  }
  return { note, files };
}

const DEPRECATED_BOOLEANS = ["y", "Y", "yes", "Yes", "YES", "on", "On", "ON", "n", "N", "no", "No", "NO", "off", "Off", "OFF"];
const BASE60 = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
const FLOAT = /^(?:[-+]?(?:[0-9]+)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TIMESTAMP = /^[0-9]{4}-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(Z|[-+][0-9][0-9]?(?::[0-9]{2})?))?$/;
const INT = /^[-+]?(?:0b[01]+|0x[0-9a-fA-F]+|0o[0-7]+|[0-9]+)$/;
const ESCAPES: Record<number, string> = {
  0x00: "\\0", 0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0a: "\\n", 0x0b: "\\v", 0x0c: "\\f", 0x0d: "\\r", 0x1b: "\\e",
  0x22: '\\"', 0x5c: "\\\\", 0x85: "\\N", 0xa0: "\\_", 0x2028: "\\L", 0x2029: "\\P",
};

const printable = (c: number) =>
  (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xd7ff && c !== 0x2028 && c !== 0x2029) || (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff) || (c >= 0x10000 && c <= 0x10ffff);
const white = (c: number) => c === 0x20 || c === 0x09;
const nsCharOrWhite = (c: number) => printable(c) && c !== 0xfeff && c !== 0x0d && c !== 0x0a;
/** js-yaml's isPlainSafe for a block value. */
const plainSafe = (c: number, prev: number | undefined) => {
  const ns = nsCharOrWhite(c) && !white(c);
  return (nsCharOrWhite(c) && c !== 0x23 && !(prev === 0x3a && !ns)) || (prev !== undefined && nsCharOrWhite(prev) && !white(prev) && c === 0x23) || (prev === 0x3a && ns);
};
const plainFirst = (c: number) => printable(c) && c !== 0xfeff && !white(c) && !"-?:,[]{}#&*!|=>'\"%@`".includes(String.fromCodePoint(c));
const intLike = (s: string) => {
  if (!INT.test(s)) return false;
  const body = s.replace(/^[-+]/, "");
  const base = ({ b: 2, o: 8, x: 16 } as Record<string, number>)[body[1]] ?? 10;
  return Number.isFinite(Number.parseInt(base === 10 ? body : body.slice(2), base));
};
/** Whether js-yaml's default schema reads the string as something else: null, a boolean, a number, a date or a merge key. */
const ambiguous = (s: string) =>
  ["~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE", "<<"].includes(s) ||
  intLike(s) ||
  (FLOAT.test(s) && (Number.isFinite(Number.parseFloat(s)) || /\.(inf|Inf|INF|nan|NaN|NAN)$/.test(s))) ||
  DATE.test(s) ||
  TIMESTAMP.test(s);

/** A one-line string as js-yaml's dump (lineWidth -1, double quotes) writes it as a block mapping value. */
export function yamlScalar(s: string): string {
  if (s === "") return '""';
  if (DEPRECATED_BOOLEANS.includes(s) || BASE60.test(s)) return `"${s}"`;
  const points = [...s].map((ch) => ch.codePointAt(0)!);
  let plain = plainFirst(points[0]) && !white(points[points.length - 1]) && points[points.length - 1] !== 0x3a;
  let double = false;
  points.forEach((c, i) => {
    if (c === 0x0a || !printable(c)) double = true;
    plain = plain && plainSafe(c, i ? points[i - 1] : undefined);
  });
  if (!double && plain && !ambiguous(s)) return s;
  return `"${points.map((c) => ESCAPES[c] ?? (printable(c) ? String.fromCodePoint(c) : `\\${c <= 0xff ? "x" : c <= 0xffff ? "u" : "U"}${c.toString(16).toUpperCase().padStart(c <= 0xff ? 2 : c <= 0xffff ? 4 : 8, "0")}`)).join("")}"`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The template's files with the settings and the reports address in place of the placeholders. */
export function fillTemplate(template: DashboardTemplate, settings: Required<DashboardSettings>, links: DashboardLinks = {}): RenderedFile[] {
  for (const k of DURATION_KEYS) {
    if (!/^[0-9a-z]+$/.test(settings[k])) throw new Error(`dashboards.${k} is ${JSON.stringify(settings[k])}; use a duration such as 4h or 1d`);
  }
  for (const k of TEXT_KEYS) {
    if (/[\r\n]/.test(settings[k])) throw new Error(`dashboards.${k} must be one line`);
  }
  // Every value by its placeholder. A duration's placeholder comes before its seconds', which it starts with.
  const values = new Map<string, string | undefined>();
  for (const k of DURATION_KEYS) values.set(PLACEHOLDERS[k], settings[k]);
  for (const k of DURATION_KEYS) values.set(String(durationSeconds(PLACEHOLDERS[k])), String(durationSeconds(settings[k])));
  for (const k of TEXT_KEYS) values.set(PLACEHOLDERS[k], settings[k]);
  values.set(REPORTS_PLACEHOLDER, links.reports);
  const text = new Set<string>([...TEXT_KEYS.map((k) => PLACEHOLDERS[k]), REPORTS_PLACEHOLDER]);
  const pattern = [...values.keys()].map(escapeRe).join("|");
  const any = new RegExp(pattern, "g");
  const has = new RegExp(pattern);
  const value = (token: string): string => {
    const v = values.get(token);
    if (v === undefined) throw new Error(`the dashboards template has ${token} and nothing to fill it with`);
    return v;
  };
  const fill = (s: string) => s.replace(any, value);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fill(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [fill(k), walk(x)]));
    return v;
  };
  const fillLine = (line: string): string => {
    const whole = /^(.*(?:: |- ))(\S+)$/.exec(line);
    if (whole && text.has(whole[2]) && !has.test(whole[1])) return `${whole[1]}${yamlScalar(value(whole[2]))}`;
    return line.replace(any, (token) => {
      if (text.has(token)) throw new Error(`the dashboards template has ${token} inside a YAML scalar: ${line}`);
      return value(token);
    });
  };

  const dir = settings.dir.replace(/\/+$/, "");
  const linked = links.reports !== undefined;
  const out: RenderedFile[] = [];
  for (const f of template.files) {
    if (f.links !== undefined && f.links !== linked) continue;
    const content = "json" in f ? JSON.stringify(walk(f.json), null, 2) + f.suffix : f.yaml.map(fillLine).join("\n");
    out.push({ path: `${dir}/${f.path}`, content });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
