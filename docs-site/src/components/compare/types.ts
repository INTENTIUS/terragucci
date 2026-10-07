// The shapes behind the comparison page. A competitor's cell cannot be
// written without a source: the type asks for at least one page of that
// product's own docs the mark was read from. The marks are not drawn; they
// decide which section a row may sit in (./sections.ts).

/** good meets by design, warn is partial or by hand, bad misses, na is out of scope. */
export type Mark = 'good' | 'warn' | 'bad' | 'na';

export type RowId =
	| 'grouped-note'
	| 'affected-only'
	| 'json-report'
	| 'policy'
	| 'override'
	| 'apply-when'
	| 'approval-binds'
	| 'waves'
	| 'refuse-changed'
	| 'locks'
	| 'terragrunt'
	| 'drift'
	| 'hosting'
	| 'state'
	| 'credentials'
	| 'telemetry'
	| 'modules'
	| 'licence'
	| 'account'
	| 'hosted'
	| 'maturity'
	| 'tg-before-merge'
	| 'gitlab-comments';

export type ProductId = 'atlantis' | 'hcp' | 'spacelift' | 'opentaco';

/** A page of a product's own documentation, pricing or licence. */
export interface Source {
	title: string;
	url: string;
}

/** A competitor's cell: the mark, what the product does, and the pages of its docs that say so. */
export interface Cell {
	mark: Mark;
	text: string;
	sources: [Source, ...Source[]];
}

/** A terragucci cell: the mark, what it does, and the page of this site that says so. */
export interface OwnCell {
	mark: Mark;
	text: string;
	/** A path under the site's base, or a full URL. */
	page: string;
}

export interface Product {
	id: ProductId;
	name: string;
	/** The column heading, when the name is too long for one. */
	short?: string;
}

export interface Row {
	id: RowId;
	label: string;
	/** What a full mark means, shown when the row is opened. */
	statement: string;
	cells: Record<ProductId, Cell>;
}
