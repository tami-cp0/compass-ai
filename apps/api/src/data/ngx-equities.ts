import { NGX_EQUITIES, type NgxEquity } from './ngx-equities-data.js';

export type { NgxEquity };

export type LookupConfidence = 'exact' | 'fuzzy' | 'none';

export interface LookupResult {
	matches: NgxEquity[];
	confidence: LookupConfidence;
}

const STOPWORDS = new Set([
	'plc', 'nigeria', 'nigerian', 'of', 'the', 'and', 'company', 'group',
	'holdings', 'holding', 'limited', 'ltd', 'inc',
]);

function normalize(raw: string): string {
	return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function tokenize(raw: string): string[] {
	return raw
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Pre-indexed lowercased helpers so lookup is hot-path cheap.
const INDEX = NGX_EQUITIES.map((e) => ({
	equity: e,
	tickerLc: e.ticker.toLowerCase(),
	companyLc: e.company.toLowerCase(),
	companyTokens: tokenize(e.company),
}));

// Classic Levenshtein distance, capped to keep hot-path bounded.
function levenshtein(a: string, b: string, cap: number): number {
	if (Math.abs(a.length - b.length) > cap) return cap + 1;
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = new Array<number>(n + 1);
	let curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= n; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1] + 1,
				prev[j] + 1,
				prev[j - 1] + cost
			);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (rowMin > cap) return cap + 1;
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

// Score 0..1 — 1 is perfect.
function similarity(a: string, b: string): number {
	if (!a || !b) return 0;
	const maxLen = Math.max(a.length, b.length);
	const cap = Math.ceil(maxLen * 0.6);
	const dist = levenshtein(a, b, cap);
	if (dist > cap) return 0;
	return 1 - dist / maxLen;
}

// Look up an NGX equity by ticker or company name.
//
// - Exact: normalized query equals a ticker (e.g. "CONHAL", "conhal", " con-hal ").
// - Fuzzy: Levenshtein similarity ≥ 0.6 on ticker OR substring/token overlap
//   on company name. Returns up to `limit` ranked matches.
// - None: nothing crossed the threshold.
//
// Designed to be called from a tool handler so the orchestrating model can
// verify a heard ticker before committing to expensive research.
// Distinct sector and sub-sector names (official NGX taxonomy), all valid
// targets for sector-mode lookups — users say "insurance" (a sub-sector) as
// readily as "consumer goods" (a sector).
const SECTORS = [...new Set(NGX_EQUITIES.map((e) => e.sector))];
const SUB_SECTORS = [...new Set(NGX_EQUITIES.flatMap((e) => (e.subSector ? [e.subSector] : [])))];
const SECTOR_NAMES = [...SECTORS, ...SUB_SECTORS];

// Look up all companies in a sector or sub-sector by (fuzzy) name. On a miss
// the response carries the full list so the caller can map its term and retry.
export function lookupSector(
	query: string
): LookupResult & { sector?: string; available_sectors?: string[] } {
	const qNorm = normalize(query);
	if (!qNorm) return { matches: [], confidence: 'none', available_sectors: SECTOR_NAMES };
	let best: { name: string; score: number } | null = null;
	for (const s of SECTOR_NAMES) {
		const sNorm = normalize(s);
		// Token-level substring: "oil" should hit "Oil and Gas", "estate" should
		// hit "Construction/Real Estate".
		const tokens = tokenize(s);
		const tokenHit = tokens.some((t) => t.includes(qNorm) || qNorm.includes(t));
		const score = sNorm.includes(qNorm) || qNorm.includes(sNorm) || tokenHit
			? 0.9
			: similarity(qNorm, sNorm);
		if (score >= 0.6 && (!best || score > best.score)) best = { name: s, score };
	}
	if (!best) return { matches: [], confidence: 'none', available_sectors: SECTOR_NAMES };
	const { name, score } = best;
	return {
		sector: name,
		matches: NGX_EQUITIES.filter((e) => e.sector === name || e.subSector === name),
		confidence: score >= 0.85 ? 'exact' : 'fuzzy',
	};
}

export function lookupTicker(query: string, limit = 5): LookupResult {
	const normQ = normalize(query);
	if (!normQ) return { matches: [], confidence: 'none' };

	const exact = INDEX.find((e) => e.tickerLc === normQ);
	if (exact) return { matches: [exact.equity], confidence: 'exact' };

	const qTokens = tokenize(query);
	const scored: Array<{ equity: NgxEquity; score: number }> = [];

	for (const e of INDEX) {
		// Ticker similarity: full string + prefix slice. Short queries vs long
		// canonical tickers (AKSESS → ACCESSCORP, OKUMU → OKOMUOIL) need the
		// prefix path because full-string Levenshtein over-penalises length gap.
		const tickerFullSim = similarity(normQ, e.tickerLc);
		const tickerPrefixSim = normQ.length >= 3 && normQ.length <= e.tickerLc.length
			? similarity(normQ, e.tickerLc.slice(0, normQ.length))
			: 0;
		const tickerSim = Math.max(tickerFullSim, tickerPrefixSim);

		// Company similarity: substring hit, else fuzzy per-token overlap.
		// Fuzzy lets MITN match the 'mtn' token in "MTN Nigeria Communications".
		let companySim = 0;
		if (e.companyLc.includes(normQ)) {
			companySim = 0.9;
		} else if (qTokens.length > 0 && e.companyTokens.length > 0) {
			let total = 0;
			for (const q of qTokens) {
				let best = 0;
				for (const c of e.companyTokens) {
					const s = similarity(q, c);
					if (s > best) best = s;
				}
				total += best;
			}
			companySim = total / qTokens.length;
		}

		const score = Math.max(tickerSim, companySim);
		if (score >= 0.6) scored.push({ equity: e.equity, score });
	}

	scored.sort((a, b) => b.score - a.score);
	const matches = scored.slice(0, limit).map((s) => s.equity);

	return matches.length > 0
		? { matches, confidence: 'fuzzy' }
		: { matches: [], confidence: 'none' };
}
