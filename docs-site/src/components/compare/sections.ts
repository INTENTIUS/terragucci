// Where each row of ./grid.ts sits on the comparison page, under what
// headline. The texts come from the grid and from ./marks.ts; this file adds
// only the headline and, for the first and last sections, one line on why it
// matters. The marks decide which section a row may sit in, and the checks
// at the bottom fail the site build when a placement and its marks disagree.
import { products, rows } from './grid';
import { terragucci } from './marks';
import type { Cell, OwnCell, Product, ProductId, Row, RowId, Source } from './types';

export type SectionId = 'different' | 'everyone' | 'further';

export interface Placement {
	section: SectionId;
	/** The grid rows this entry is read from, in order; their texts are joined. */
	rows: [RowId, ...RowId[]];
	headline: string;
	/** One line on why it matters; the compact section has none. */
	why?: string;
}

export const placements: Placement[] = [
	{
		section: 'different',
		rows: ['hosting', 'account'],
		headline: 'Runs in your CI, lands in your repo and bucket',
		why: 'Plans, approvals and applies are jobs on the GitHub, GitLab or Forgejo runners you have. Approvals are commits on your chant/lifecycle branch and reports go to a CI artifact or your bucket. There is no account to sign up for, no server to host and no sign-in to read a plan.',
	},
	{
		section: 'different',
		rows: ['approval-binds', 'refuse-changed'],
		headline: 'An approval covers exactly the plans that apply',
		why: 'A reviewer approves what they read. If a plan moves after approval, nothing applies until someone approves again.',
	},
	{
		section: 'different',
		rows: ['waves', 'terragrunt'],
		headline: 'Each dependency layer is its own gated wave, Terragrunt included',
		why: 'A bad change stops at the canary or the first layer, before it reaches the roots that read its outputs.',
	},
	{
		section: 'different',
		rows: ['grouped-note'],
		headline: 'One note for every plan in the pull request',
		why: 'Roots taking the same change read as one line with a count, so destroys and outliers stand out.',
	},
	{
		section: 'different',
		rows: ['affected-only'],
		headline: 'Plans every root a changed module reaches',
		why: 'A module edit shows its effect on each root that uses it, with no path patterns to keep up to date.',
	},
	{
		section: 'different',
		rows: ['policy'],
		headline: 'Policy is read from the base branch',
		why: 'A pull request is judged by the policy already merged, so a change to the policy is reviewed on its own first.',
	},
	{
		section: 'different',
		rows: ['json-report'],
		headline: 'One JSON report for the whole run',
		why: 'Scripts and agents read every root, group, policy result and wave from one documented file.',
	},
	{
		section: 'different',
		rows: ['telemetry'],
		headline: 'Traces and metrics for every run',
		why: 'Stage and root timings land in the OpenTelemetry backend you already use, with Grafana dashboards to start from.',
	},
	{
		section: 'different',
		rows: ['modules'],
		headline: 'Module publishing and pinned rollouts',
		why: 'A new module version reaches the roots that pin it one wave at a time, each wave a pull request your team reviews.',
	},
	{ section: 'everyone', rows: ['locks'], headline: 'Root locks' },
	{ section: 'everyone', rows: ['drift'], headline: 'Drift detection' },
	{ section: 'everyone', rows: ['apply-when'], headline: 'Apply before or after merge' },
	{ section: 'everyone', rows: ['tg-before-merge'], headline: 'Apply before merge in a Terragrunt repo' },
	{ section: 'everyone', rows: ['credentials'], headline: 'Short-lived cloud credentials' },
	{ section: 'everyone', rows: ['state'], headline: 'State in your own backend' },
	{ section: 'everyone', rows: ['licence'], headline: 'Open source or a free plan' },
	{
		section: 'further',
		rows: ['hosted'],
		headline: 'A hosted web app',
		why: 'A vendor runs the service, and runs, plans and history are browsed in its web app.',
	},
	{
		section: 'further',
		rows: ['override'],
		headline: 'A recorded policy override',
		why: 'Named people can let one plan through a failed policy, and the override is kept.',
	},
	{
		section: 'further',
		rows: ['maturity'],
		headline: 'Years in production',
		why: 'A longer record, more users and more answers already written down.',
	},
	{
		section: 'further',
		rows: ['gitlab-comments'],
		headline: 'Comment commands on GitLab',
		why: 'A merge request comment re-plans or applies, as it does on GitHub.',
	},
];

const rowOf = new Map(rows.map((r) => [r.id, r]));
const row = (id: RowId): Row => {
	const r = rowOf.get(id);
	if (!r) throw new Error(`compare: no grid row ${id}`);
	return r;
};

/** One product's line in an opened entry: its cells' texts joined, and the pages they cite. */
export interface Line {
	product: Product;
	text: string;
	sources: Source[];
}

/** terragucci's line: its cells' texts joined, and the pages of this site that say so. */
export interface OwnLine {
	text: string;
	pages: string[];
}

const join = (texts: string[]) => texts.map((t) => `${t}.`).join(' ');
const unique = <T>(xs: T[]) => [...new Set(xs)];

export const lineOf = (p: Placement, product: Product): Line => {
	const cells: Cell[] = p.rows.map((id) => row(id).cells[product.id]);
	const sources = cells.flatMap((c) => c.sources);
	return {
		product,
		text: join(cells.map((c) => c.text)),
		sources: sources.filter((s, i) => sources.findIndex((t) => t.url === s.url) === i),
	};
};

export const ownLineOf = (p: Placement): OwnLine => {
	const cells: OwnCell[] = p.rows.map((id) => terragucci[id]);
	return { text: join(cells.map((c) => c.text)), pages: unique(cells.map((c) => c.page)) };
};

/** A product meets an entry when it meets every row the entry is read from. */
export const meets = (p: Placement, id: ProductId) => p.rows.every((r) => row(r).cells[id].mark === 'good');
export const ownMeets = (p: Placement) => p.rows.every((r) => terragucci[r].mark === 'good');

/** The products that meet an entry in full. */
export const who = (p: Placement) => ({ meet: products.filter((x) => meets(p, x.id)) });

export const inSection = (s: SectionId) => placements.filter((p) => p.section === s);

// Notes are numbered in reading order, one per page, so two lines read from
// the same page share a number.
export const notes: (Source & { product: string })[] = [];
const noteOf = new Map<string, number>();
for (const s of ['different', 'everyone', 'further'] as const) {
	for (const p of inSection(s)) {
		for (const x of products) {
			for (const source of lineOf(p, x).sources) {
				if (!noteOf.has(source.url)) {
					notes.push({ ...source, product: x.name });
					noteOf.set(source.url, notes.length);
				}
			}
		}
	}
}
export const note = (s: Source) => noteOf.get(s.url) as number;

// Every row sits in one place. A row where terragucci is different is met
// by terragucci and by at most one other product; a row where others go
// further is met by at least one of them and not fully by terragucci.
const placed = placements.flatMap((p) => p.rows);
for (const r of rows) {
	const n = placed.filter((id) => id === r.id).length;
	if (n !== 1) throw new Error(`compare: row ${r.id} is placed ${n} times`);
}
for (const p of placements) {
	const others = products.filter((x) => meets(p, x.id)).length;
	if (p.section === 'different' && (!ownMeets(p) || others > 1)) {
		throw new Error(`compare: ${p.headline} is not where terragucci is different`);
	}
	if (p.section === 'further' && (ownMeets(p) || others === 0)) {
		throw new Error(`compare: ${p.headline} is not where others go further`);
	}
}
