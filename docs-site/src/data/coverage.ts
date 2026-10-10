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


// What a tool or forge refuses by design, by area. whole: the area has nothing
// else there, so the cell reads "not supported" instead of "none".
export type Limit = { column: string; area: string; text: string; whole?: boolean };
export const LIMITS: Limit[] = [
	{ column: 'GitLab', area: 'Locks and safety', text: 'Locks from the first plan (locks: plan) are refused on GitLab, where no merge request event runs a job from the default branch.' },
	{ column: 'Terragrunt', area: 'Setup and runtime', text: 'A Terragrunt repo takes no synth, so a CDK Terrain app cannot run in one.' },
	{ column: 'CDK Terrain', area: 'Setup and runtime', text: 'A CDK Terrain app cannot run in a Terragrunt repo, which takes no synth.' },
	{ column: 'Atmos', area: 'Drift', text: 'The drift pull request is refused: a live value belongs in the stack vars or the component.' },
	{ column: 'Terramate', area: 'Drift', text: 'The drift pull request is refused: a live value belongs in the stack .tm.hcl or its own Terraform.' },
	{ column: 'CDK Terrain', area: 'Drift', text: 'The drift pull request is refused: a live value belongs in the app that writes the stacks.' },
	{ column: 'Atmos', area: 'Modules', text: 'Rollouts are refused: every instance of a component shares its files, so no wave can move a pin alone.' },
	{ column: 'Terramate', area: 'Modules', text: 'Rollouts are refused: the pin is usually in code terramate generate writes.' },
	{ column: 'CDK Terrain', area: 'Modules', text: 'Rollouts are refused: the pin is in the app that writes the stacks.' },
	{ column: 'Atmos', area: 'Agents and pull request environments', text: 'A copy per pull request is refused: the stack backend and workspace name the state of an instance.' },
];

export type State = Status | 'same' | 'unsupported' | 'none';
export type Claim = { claim: string; says: string; status: Status; githubCom: boolean };
export type Cell = { state: State; claims: Claim[]; same: Claim[]; limits: Limit[] };

export const RANK: Record<Status, number> = { fails: 0, passes: 1, proven: 2 };
// One entry per claim, at its weakest result in the cell.
const claimsIn = (picked: Row[]): Claim[] => {
	const by = new Map<string, Claim>();
	for (const r of picked) {
		const was = by.get(r.claim);
		if (!was || RANK[r.status] < RANK[was.status]) by.set(r.claim, { claim: r.claim, says: r.says, status: r.status, githubCom: r.githubCom });
	}
	return [...by.values()];
};

export const cellOf = (col: Col, area: string): Cell => {
	const claims = claimsIn(rows.filter((r) => r.area === area && col.take(r)));
	const limits = LIMITS.filter((l) => l.column === col.label && l.area === area);
	// Terraform and choudoufu re-run only the checks where the binary matters;
	// the rest of the area runs the same code on every binary.
	const tofu = col.binary && col.binary !== 'tofu' ? claimsIn(rows.filter((r) => r.area === area && TOOL[0]!.take(r))) : [];
	const same = tofu.filter((t) => !claims.some((c) => c.claim === t.claim));
	let state: State;
	if (claims.length) state = claims.some((c) => c.status === 'fails') ? 'fails' : claims.every((c) => c.status === 'proven') ? 'proven' : 'passes';
	else if (same.length) state = 'same';
	else if (limits.some((l) => l.whole)) state = 'unsupported';
	else state = 'none';
	return { state, claims, same, limits };
};


/** How many checks are proven for one tool, repo shape or forge: a grid column's label, or "Plain roots". */
export const provenFor = (label: string): number => {
	const col = [...TOOL, ...FORGE].find((c) => c.label === label);
	const take = col ? col.take : (r: Row) => r.forge === 'Forgejo' && r.shape === label;
	return new Set(rows.filter((r) => take(r) && r.status === 'proven').map((r) => r.claim)).size;
};

/** A cell the grids show as not yet proven, and the command or claim that would fill it. */
export type Gap = { grid: 'tool' | 'forge'; column: string; area: string; state: State; claims: string[]; fill: string };

const SHAPE_PREFIX: Record<string, string> = { Terragrunt: 'tg-', Atmos: 'atmos-', Terramate: 'terramate-', 'CDK Terrain': 'cdktn-' };

const fillFor = (grid: Gap['grid'], col: Col, cell: Cell): { claims: string[]; fill: string } => {
	const weak = cell.claims.filter((c) => c.status !== 'proven').map((c) => c.claim).sort();
	if (cell.state === 'fails') return { claims: cell.claims.filter((c) => c.status === 'fails').map((c) => c.claim).sort(), fill: 'fix the failing claims, then record them again' };
	if (cell.state === 'same' && col.binary) {
		// One plain-roots check of the area on the binary turns the cell from "same code" to proven;
		// the shape claims (tg-, atmos-, terramate-, cdktn-) run their own repos.
		const names = cell.same.map((c) => c.claim).filter((n) => !/^(tg|atmos|terramate|cdktn|cdf)-/.test(n)).sort();
		const pick = names.slice(0, 3);
		return { claims: names, fill: `add one or more to BINARY_CLAIMS in stack/smoke.sh, then: just binary-claims ${col.binary} '${pick.join(' ')}'` };
	}
	if (cell.state === 'passes') {
		return grid === 'forge' && col.label === 'GitHub'
			? { claims: weak, fill: 'a BREAK variant in stack/sandbox-github.sh, then: just sandbox prove --break --record docs-site/src/data/validation.json' }
			: { claims: weak, fill: 'record the claims under BREAK=1: just claims <name>' };
	}
	if (grid === 'forge' && col.label === 'GitHub') return { claims: [], fill: 'a github.com claim in PROVE_CLAIMS (stack/sandbox-github.sh), then: just sandbox prove --record docs-site/src/data/validation.json' };
	if (grid === 'forge' && col.label === 'GitLab') return { claims: [], fill: "a GitLab claim in GITLAB_CLAIMS (stack/smoke-gitlab.sh), then: just gitlab-claims '<name>'" };
	const prefix = SHAPE_PREFIX[col.label];
	return { claims: [], fill: prefix ? `a claim named ${prefix}<name> in CLAIMS (stack/smoke.sh), then: just claims <name>` : 'a claim in CLAIMS (stack/smoke.sh), then: just claims <name>' };
};

/** Every cell of both grids that is not proven or not supported by design, with what would fill it. */
export const gaps = (): Gap[] => {
	const out: Gap[] = [];
	for (const [grid, cols] of [['tool', TOOL], ['forge', FORGE]] as const) {
		for (const col of cols) {
			for (const area of AREAS) {
				const cell = cellOf(col, area);
				if (cell.state === 'proven' || cell.state === 'unsupported') continue;
				out.push({ grid, column: col.label, area, state: cell.state, ...fillFor(grid, col, cell) });
			}
		}
	}
	return out;
};
