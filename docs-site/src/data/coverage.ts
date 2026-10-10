// Every recorded check as one row: its feature area, forge, binary, repo
// shape and status, from smoke.json, validation.json and claim-areas.json.
// The coverage grids and the home page's picker both count these rows.
import smoke from './smoke.json';
import validation from './validation.json';
import areaMap from './claim-areas.json';

type SmokeRow = { claim: string; says: string; verdict: string; break: string | null; forge?: string; binary?: string };
type ValidationRow = { forge: string; claim: string; says: string; verdict: string; break: string | null };
export type Status = 'proven' | 'passes' | 'fails';
export type Binary = 'tofu' | 'terraform' | 'choudoufu';
export type Forge = 'Forgejo' | 'GitHub' | 'GitLab';
export type Row = { claim: string; says: string; area: string; forge: Forge; binary: Binary; shape: string; status: Status; githubCom: boolean };

export const AREAS = areaMap.areas;
const AREA = areaMap.claims as Record<string, string>;
const CONFIG_BINARY = areaMap.binary as Record<string, Binary>;
const FORGE_OF = areaMap.forge as Record<string, string>;
const FORGE_NAMES: Record<string, Forge> = { forgejo: 'Forgejo', github: 'GitHub', 'github.com': 'GitHub', gitlab: 'GitLab' };

// steward checks the validation stack's own runtime, which no setting reaches.
const STACK_ONLY = new Set(['steward']);

const statusOf = (verdict: string, brk: string | null): Status | undefined => {
	if (verdict === 'pending') return undefined;
	if (verdict !== 'pass') return 'fails';
	return brk === 'caught' ? 'proven' : 'passes';
};
const shapeOf = (claim: string): string => {
	if (claim.startsWith('tg-') || claim === 'import-tg-scale') return 'Terragrunt';
	if (claim.startsWith('atmos-')) return 'Atmos';
	if (claim.startsWith('terramate-')) return 'Terramate';
	if (claim.startsWith('cdktn-')) return 'CDK Terrain';
	return 'Plain roots';
};
// A row with no binary ran on OpenTofu, unless its claim sets the binary in
// its own config; a cdf- claim runs a choudoufu estate.
const binaryOf = (claim: string, binary?: string): Binary =>
	(binary as Binary | undefined) ?? CONFIG_BINARY[claim] ?? (claim.startsWith('cdf-') ? 'choudoufu' : 'tofu');

export const rows: Row[] = [];
for (const r of smoke.claims as SmokeRow[]) {
	const status = statusOf(r.verdict, r.break);
	if (!status || STACK_ONLY.has(r.claim)) continue;
	const forge = FORGE_NAMES[FORGE_OF[r.claim] ?? r.forge ?? 'forgejo']!;
	rows.push({ claim: r.claim, says: r.says, area: AREA[r.claim]!, forge, binary: binaryOf(r.claim, r.binary), shape: shapeOf(r.claim), status, githubCom: false });
}
for (const r of validation.claims as ValidationRow[]) {
	const status = statusOf(r.verdict, r.break);
	const forge = FORGE_NAMES[r.forge];
	if (!status || !forge) continue;
	rows.push({ claim: r.claim, says: r.says, area: AREA[r.claim]!, forge, binary: binaryOf(r.claim), shape: shapeOf(r.claim), status, githubCom: r.forge === 'github.com' });
}

export type Col = { label: string; group?: string; binary?: Binary; take: (r: Row) => boolean };
export const TOOL: Col[] = [
	{ label: 'OpenTofu', group: 'Binary', binary: 'tofu', take: (r) => r.forge === 'Forgejo' && r.binary === 'tofu' },
	{ label: 'Terraform', group: 'Binary', binary: 'terraform', take: (r) => r.forge === 'Forgejo' && r.binary === 'terraform' },
	{ label: 'choudoufu', group: 'Binary', binary: 'choudoufu', take: (r) => r.forge === 'Forgejo' && r.binary === 'choudoufu' },
	{ label: 'Terragrunt', group: 'Repo shape', take: (r) => r.forge === 'Forgejo' && r.shape === 'Terragrunt' },
	{ label: 'Atmos', group: 'Repo shape', take: (r) => r.forge === 'Forgejo' && r.shape === 'Atmos' },
	{ label: 'Terramate', group: 'Repo shape', take: (r) => r.forge === 'Forgejo' && r.shape === 'Terramate' },
	{ label: 'CDK Terrain', group: 'Repo shape', take: (r) => r.forge === 'Forgejo' && r.shape === 'CDK Terrain' },
];
export const FORGE: Col[] = (['Forgejo', 'GitHub', 'GitLab'] as const).map((f) => ({ label: f, take: (r: Row) => r.forge === f }));


/** How many checks are proven for one tool, repo shape or forge: a grid column's label, or "Plain roots". */
export const provenFor = (label: string): number => {
	const col = [...TOOL, ...FORGE].find((c) => c.label === label);
	const take = col ? col.take : (r: Row) => r.forge === 'Forgejo' && r.shape === label;
	return new Set(rows.filter((r) => take(r) && r.status === 'proven').map((r) => r.claim)).size;
};
