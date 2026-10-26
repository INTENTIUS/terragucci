// Types for scripts/demo-asks.mjs, which runs with plain node.
export declare const REFERENCE: string;
export type AskDifference = { where: string; reference: string; other: string };
export declare function subjectless(s: string): string;
export declare function problems(ref: Record<string, unknown>, other: Record<string, unknown>, label?: string): string[];
export declare function differences(ref: Record<string, unknown>, other: Record<string, unknown>, label?: string): AskDifference[];
export declare function compareDir(dir: string, root?: string): { problems: string[]; differences: AskDifference[] };
