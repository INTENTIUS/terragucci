// A TextMate grammar for Rego, so ```rego fences on the policy page are
// highlighted. Shiki bundles no Rego grammar. This one covers what the docs
// show: comments, keywords, strings, numbers, rule heads and calls.
export default {
	name: 'rego',
	scopeName: 'source.rego',
	aliases: ['opa'],
	patterns: [
		{ include: '#comment' },
		{ include: '#string' },
		{ include: '#number' },
		{ include: '#keyword' },
		{ include: '#constant' },
		{ include: '#rule-head' },
		{ include: '#call' },
		{ include: '#operator' },
		{ include: '#variable' },
	],
	repository: {
		comment: {
			name: 'comment.line.number-sign.rego',
			match: '#.*$',
		},
		string: {
			patterns: [
				{
					name: 'string.quoted.double.rego',
					begin: '"',
					end: '"',
					patterns: [{ name: 'constant.character.escape.rego', match: '\\\\.' }],
				},
				{
					name: 'string.quoted.raw.rego',
					begin: '`',
					end: '`',
				},
			],
		},
		number: {
			name: 'constant.numeric.rego',
			match: '\\b-?\\d+(\\.\\d+)?([eE][+-]?\\d+)?\\b',
		},
		keyword: {
			patterns: [
				{ name: 'keyword.other.package.rego', match: '\\b(package|import|as)\\b' },
				{
					name: 'keyword.control.rego',
					match: '\\b(default|else|not|some|every|in|if|contains|with)\\b',
				},
			],
		},
		constant: {
			name: 'constant.language.rego',
			match: '\\b(true|false|null)\\b',
		},
		'rule-head': {
			match: '^([A-Za-z_][A-Za-z0-9_]*)(?=\\s*(contains|if|:=|=|\\[|\\{|\\())',
			captures: { 1: { name: 'entity.name.function.rego' } },
		},
		call: {
			match: '\\b([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)(?=\\()',
			captures: { 1: { name: 'support.function.rego' } },
		},
		operator: {
			patterns: [
				// Comparison first, so == is not read as two assignments.
				{ name: 'keyword.operator.comparison.rego', match: '==|!=|<=|>=|<|>' },
				{ name: 'keyword.operator.assignment.rego', match: ':=|=' },
				{ name: 'keyword.operator.arithmetic.rego', match: '\\+|-|\\*|/|%|&|\\|' },
			],
		},
		variable: {
			name: 'variable.other.rego',
			match: '\\b(input|data)\\b',
		},
	},
};
