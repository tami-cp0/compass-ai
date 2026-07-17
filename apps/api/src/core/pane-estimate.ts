// The model sometimes wraps the whole pane body in a ```/~~~ fence, rendering
// it as one literal code block. Unwrap a fence spanning the full body before
// sending. Never unwrap info string "chart" — that's a real single-chart body.
// The extension applies the same rule render-side (pin-panel.tsx) as a backstop.
const FENCE_OPEN = /^(`{3,}|~{3,})\s*(\S*)\s*$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})\s*$/;
const ANY_FENCE = /^\s{0,3}(`{3,}|~{3,})/m;

export function unwrapOuterFence(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	let first = 0;
	while (first < lines.length && lines[first].trim() === '') first++;
	let last = lines.length - 1;
	while (last >= 0 && lines[last].trim() === '') last--;
	if (last - first < 2) return markdown;

	const open = lines[first].trim().match(FENCE_OPEN);
	if (!open || open[2].toLowerCase() === 'chart') return markdown;

	const close = lines[last].trim().match(FENCE_CLOSE);
	if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) {
		return lines.slice(first + 1, last).join('\n');
	}
	// No closing fence (model dropped it). Strip the opener only when the
	// wrapped content itself contains a fence — strong evidence this was a
	// wrapper hiding nested blocks, not an intentional (if malformed) code block.
	const inner = lines.slice(first + 1).join('\n');
	return ANY_FENCE.test(inner) ? inner : markdown;
}
