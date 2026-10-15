// Types for scripts/demo-text.mjs, which scripts/lint-docs.mjs runs with plain node.
export declare const BUDGETS: Record<"problem" | "changes" | "watch" | "shows" | "title" | "name" | "step" | "action", number>;
export declare const SAMPLES: Record<string, string>;
export type DemoString = { kind: "title" | "name" | "step" | "action"; where: string; raw: string };
export declare function fill(raw: string): { text: string; unknown: string[] };
export declare function demoStrings(src: string): DemoString[];
export declare function demoProblems(src: string, file?: string): string[];
export declare function cardProblems(root?: string): string[];
