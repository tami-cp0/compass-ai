import type Anthropic from '@anthropic-ai/sdk';
import type { AgentAction } from '@compass-ai/types';

// The tool set handed to Sonnet: Anthropic's native `computer` tool (with zoom
// enabled) for mouse/keyboard/inspection, plus two custom tools for terminating
// the run. `computer_20251124` is the version trained for Sonnet 5.
export function TOOLS(width: number, height: number): Anthropic.Beta.BetaToolUnion[] {
	return [
		{
			type: 'computer_20251124',
			name: 'computer',
			display_width_px: width,
			display_height_px: height,
			enable_zoom: true,
		},
		{
			name: 'task_done',
			description:
				'Finish successfully. evidence MUST cite specific content visible in the CURRENT screenshot — a number, a row, a title, a timestamp. An empty panel is not evidence.',
			input_schema: {
				type: 'object',
				properties: {
					evidence: { type: 'string' },
				},
				required: ['evidence'],
			},
		},
		{
			name: 'task_fail',
			description:
				'Give up. Only when the task is structurally impossible, or you have tried and exhausted real alternatives. Provide a concrete reason.',
			input_schema: {
				type: 'object',
				properties: {
					reason: { type: 'string' },
				},
				required: ['reason'],
			},
		},
	];
}

export interface MappedStep {
	actions: AgentAction[];
	// tool_use ids aligned index-wise with `actions` (so each gets a tool_result).
	toolUseIds: string[];
	// tool_use ids that mapped to NO browser action (e.g. a bare `screenshot` or
	// an unmapped key). The API still requires a tool_result for each, so the
	// loop answers them with the fresh screenshot — they resolve by the next
	// observation the loop sends every turn regardless.
	noopToolUseIds: string[];
	terminal: { kind: 'done'; evidence: string } | { kind: 'fail'; reason: string } | null;
}

// Translate the assistant's tool_use blocks into our AgentAction wire form.
// The `computer` tool's `action` selects the gesture; custom tools terminate.
// EVERY non-terminal tool_use id must be surfaced (executed or no-op) so the
// loop can return a tool_result for each — the API rejects any that is missed.
export function mapToolUse(content: Anthropic.Beta.BetaContentBlock[]): MappedStep {
	const actions: AgentAction[] = [];
	const toolUseIds: string[] = [];
	const noopToolUseIds: string[] = [];
	let terminal: MappedStep['terminal'] = null;

	for (const block of content) {
		if (block.type !== 'tool_use') continue;
		const input = (block.input ?? {}) as Record<string, unknown>;

		if (block.name === 'task_done') {
			terminal = { kind: 'done', evidence: String(input.evidence ?? '') };
			continue;
		}
		if (block.name === 'task_fail') {
			terminal = { kind: 'fail', reason: String(input.reason ?? '') };
			continue;
		}
		if (block.name === 'computer') {
			const action = mapComputerAction(input);
			if (action) {
				actions.push(action);
				toolUseIds.push(block.id);
			} else {
				noopToolUseIds.push(block.id);
			}
		} else {
			// Unknown custom tool — still owes a result.
			noopToolUseIds.push(block.id);
		}
	}

	return { actions, toolUseIds, noopToolUseIds, terminal };
}

function mapComputerAction(input: Record<string, unknown>): AgentAction | null {
	const action = String(input.action ?? '');
	const [cx, cy] = coord(input.coordinate);

	switch (action) {
		case 'left_click':
		case 'mouse_move': // treated as a click target; a bare hover rarely matters here
			return { variant: 'mouse:click', x: cx, y: cy };
		case 'right_click':
			return { variant: 'mouse:right_click', x: cx, y: cy };
		case 'middle_click':
			return { variant: 'mouse:click', x: cx, y: cy };
		case 'double_click':
			return { variant: 'mouse:double_click', x: cx, y: cy };
		case 'triple_click':
			// No triple in the executor; a double-click selects enough for our uses.
			return { variant: 'mouse:double_click', x: cx, y: cy };
		case 'left_click_drag': {
			const [sx, sy] = coord(input.start_coordinate);
			return { variant: 'mouse:drag', from: { x: sx, y: sy }, to: { x: cx, y: cy } };
		}
		case 'scroll': {
			const dir = String(input.scroll_direction ?? 'down');
			const amount = int(input.scroll_amount ?? 3) * 100; // clicks → wheel px
			const deltaY = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
			const deltaX = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
			return { variant: 'mouse:scroll', x: cx, y: cy, deltaX, deltaY };
		}
		case 'type':
			return { variant: 'keyboard:type', content: String(input.text ?? '') };
		case 'key':
			return mapKey(String(input.text ?? ''));
		case 'wait':
			return { variant: 'wait', seconds: typeof input.duration === 'number' ? input.duration : 1 };
		case 'zoom': {
			// The model wants to inspect a region closely. Instead of an image
			// crop, we answer with that region's exact DOM text (page:read) —
			// ground-truth characters beat re-reading a zoomed image for digits.
			const [x1, y1, x2, y2] = region(input.region);
			return { variant: 'page:read', x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
		}
		default:
			// screenshot / cursor_position / hold_key / mouse down-up — our loop
			// hands back a fresh screenshot every turn regardless, so a bare
			// screenshot request needs no action; the rest are unused.
			return null;
	}
}

// Map a computer `key` chord (xdotool syntax, e.g. "Return", "ctrl+a", "Tab")
// to our discrete keyboard variants where one exists; otherwise fall back to
// typing the literal for plain characters.
function mapKey(chord: string): AgentAction | null {
	const k = chord.toLowerCase().trim();
	if (k === 'return' || k === 'enter' || k === 'kp_enter') return { variant: 'keyboard:enter' };
	if (k === 'tab') return { variant: 'keyboard:tab' };
	if (k === 'backspace') return { variant: 'keyboard:backspace' };
	if (k === 'ctrl+a' || k === 'cmd+a' || k === 'super+a') return { variant: 'keyboard:select_all' };
	return null;
}

// Scale a coordinate-bearing action from image space to CSS space by factor s.
// Non-spatial actions (keyboard, nav, wait, terminals) pass through unchanged.
export function scaleAction(a: AgentAction, s: number): AgentAction {
	const px = (n: number) => Math.round(n * s);
	switch (a.variant) {
		case 'mouse:click':
		case 'mouse:double_click':
		case 'mouse:right_click':
			return { ...a, x: px(a.x), y: px(a.y) };
		case 'mouse:scroll':
			// deltas scale too, so a "scroll 3 clicks" gesture moves the same
			// visual distance in CSS space.
			return { ...a, x: px(a.x), y: px(a.y), deltaX: px(a.deltaX), deltaY: px(a.deltaY) };
		case 'mouse:drag':
			return { ...a, from: { x: px(a.from.x), y: px(a.from.y) }, to: { x: px(a.to.x), y: px(a.to.y) } };
		case 'page:read':
			return { ...a, x: px(a.x), y: px(a.y), width: px(a.width), height: px(a.height) };
		default:
			return a;
	}
}

function coord(v: unknown): [number, number] {
	if (Array.isArray(v) && v.length >= 2) return [int(v[0]), int(v[1])];
	return [0, 0];
}

function region(v: unknown): [number, number, number, number] {
	if (Array.isArray(v) && v.length >= 4) return [int(v[0]), int(v[1]), int(v[2]), int(v[3])];
	return [0, 0, 0, 0];
}

function int(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? Math.round(n) : 0;
}
