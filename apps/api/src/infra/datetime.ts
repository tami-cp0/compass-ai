// Human-readable timestamp helper for orchestrator injections and the
// Gemini Live session-start system prompt. Anchored to Africa/Lagos
// because the user, the market (NGX), and the broker (Atlass) are all
// in West Africa Time — no timezone conversion needed at the model layer.

const FORMATTER = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Africa/Lagos',
	weekday: 'long',
	day: 'numeric',
	month: 'long',
	year: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
	hour12: true,
	timeZoneName: 'short',
});

// e.g. "Friday, 12 June 2026 at 4:18 PM WAT"
export function nowReadableWAT(): string {
	const parts = FORMATTER.formatToParts(new Date());
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? '';
	const weekday = get('weekday');
	const day = get('day');
	const month = get('month');
	const year = get('year');
	const hour = get('hour');
	const minute = get('minute');
	const dayPeriod = get('dayPeriod');
	const tz = get('timeZoneName');
	return `${weekday}, ${day} ${month} ${year} at ${hour}:${minute} ${dayPeriod} ${tz}`;
}
