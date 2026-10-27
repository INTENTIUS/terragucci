/**
 * HCL text helpers publish reads a module's declarations with: chant's
 * (`compose/hcl.ts` and `compose/root.ts` of the Terraform lexicon), kept
 * here because chant 0.124.52 and earlier have no `/compose` subpath
 * (terragucci#1278), and terragucci still runs on them. They were terragucci's before chant lifted them.
 */

/** The text with every comment blanked to spaces, newlines kept, so offsets still match. Strings are left alone. */
export function blankComments(text: string): string {
  const out = text.split("");
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      for (; i < text.length && text[i] !== "\n"; i++) out[i] = " ";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
      i--;
    }
  }
  return out.join("");
}

/** The end (exclusive) of the expression that starts at `i`: to the end of its line, or further while a bracket or a string is open. */
function exprEnd(text: string, i: number): number {
  let depth = 0;
  let inString = false;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && depth === 0) return i;
  }
  return i;
}

/** The top-level `name = expression` attributes of an HCL attribute file (a `.tfvars`), comments blanked. */
export function hclAttributes(text: string): Map<string, string> {
  const t = blankComments(text);
  const out = new Map<string, string>();
  const re = /(^|\n)[ \t]*([A-Za-z_][\w-]*)[ \t]*=(?!=)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const start = m.index + m[0].length;
    const end = exprEnd(t, start);
    out.set(m[2]!, t.slice(start, end).trim());
    re.lastIndex = end;
  }
  return out;
}
