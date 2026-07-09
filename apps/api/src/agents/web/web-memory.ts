import type { AgentAction, AgentActionResult } from '@compass-ai/types';

// Lightweight memory for the web agent loop: the task goal plus a rolling
// window of recent turns, giving continuity without paying for full history.
// Kept small because the model is vision-driven and extra screenshots blow the
// token budget with no accuracy gain.

export interface MemoryTurn {
	stepNumber: number;
	reasoning: string;
	progressNote: string;
	pageChanged: boolean;
	actions: AgentAction[];
	results: AgentActionResult[];
}

// Variants that can loop without progress: pointer inputs, waiting, scrolling.
// Typing/navigation are excluded (they legitimately change state). Scrolling is
// included because a page_changed:false scroll is a genuine no-op; a scroll that
// reveals content reports page_changed:true and resets the streak.
const LOOPABLE_VARIANTS = new Set<string>([
	'mouse:click',
	'mouse:double_click',
	'mouse:right_click',
	'mouse:scroll',
	'wait',
]);

export class WebAgentMemory {
	readonly goal: string;
	private turns: MemoryTurn[] = [];

	constructor(goal: string) {
		this.goal = goal;
	}

	get stepCount(): number {
		return this.turns.length;
	}

	recordTurn(
		reasoning: string,
		progressNote: string,
		pageChanged: boolean,
		actions: AgentAction[],
		results: AgentActionResult[]
	): void {
		this.turns.push({
			stepNumber: this.turns.length + 1,
			reasoning,
			progressNote,
			pageChanged,
			actions,
			results,
		});
	}

	// Consecutive most-recent turns where the model itself reported no page
	// change AND the batch that preceded that report was click/wait-only.
	// The model observes "nothing changed" reliably; this makes the system
	// act on it instead of trusting the model to break its own loop.
	get noProgressStreak(): number {
		let streak = 0;
		for (let i = this.turns.length - 1; i >= 1; i--) {
			const turn = this.turns[i];
			const prev = this.turns[i - 1];
			const prevClickOnly =
				prev.actions.length > 0 &&
				prev.actions.every((a) => LOOPABLE_VARIANTS.has(a.variant));
			if (!turn.pageChanged && prevClickOnly) streak++;
			else break;
		}
		return streak;
	}

	// Mechanical circuit-breaker notice for the next prompt. Fires at 2
	// consecutive no-op batches (one warning); the loop force-fails at 3.
	// Wording adapts to what the agent was actually repeating — scrolling and
	// clicking need different corrective advice.
	noProgressNotice(): string | null {
		const streak = this.noProgressStreak;
		if (streak < 2) return null;
		const recentActions = this.turns.slice(-streak - 1, -1).flatMap((t) => t.actions);
		const scrolled = recentActions.some((a) => a.variant === 'mouse:scroll');
		const clicked = recentActions.some(
			(a) => a.variant === 'mouse:click' || a.variant === 'mouse:double_click'
		);

		// Scroll-only loop: the target is not below the fold.
		if (scrolled && !clicked) {
			return (
				`NOTICE: Your last ${streak} scroll batches produced NO page change — by your own reports. ` +
				`You are at the scroll limit or this area does not scroll. The content you are looking for is NOT ` +
				`below the fold. Either it is ALREADY visible in the current screenshot — if so, read it and finish ` +
				`the task — or it lives elsewhere (a different panel, tab, or the sidebar navigation). Do NOT scroll ` +
				`the same way again.`
			);
		}

		const clicks = recentActions
			.filter(
				(a): a is Extract<AgentAction, { x: number; y: number }> =>
					a.variant === 'mouse:click' || a.variant === 'mouse:double_click'
			)
			.map((a) => `(${a.x}, ${a.y})`)
			.join(', ');
		return (
			`NOTICE: Your last ${streak} click batches${clicks ? ` at ${clicks}` : ''} produced NO page change — ` +
			`by your own reports. Whatever you are clicking is not interactive or not responding. ` +
			`Do NOT click there again. Take a different route to the goal: a different control, ` +
			`the sidebar/menu navigation, or scroll to reveal alternatives.`
		);
	}

	// All progress notes, oldest → newest, formatted as "Step N: <note>".
	// Used to hand the externalized action log to the orchestrating model.
	renderProgressLog(): string {
		return this.turns
			.map((t) => `Step ${t.stepNumber}: ${t.progressNote}`)
			.join('\n');
	}

	// Last N progress notes for mid-run heartbeats.
	recentProgressNotes(count: number): { stepNumber: number; note: string }[] {
		return this.turns.slice(-count).map((t) => ({
			stepNumber: t.stepNumber,
			note: t.progressNote,
		}));
	}

	// Recent turn summary for the next prompt. Last 5 turns is enough to
	// recover from failures without paying for the whole history. Older
	// reasonings are dropped — the screenshot carries the state.
	renderRecentHistory(): string {
		if (this.turns.length === 0) return '';
		const recent = this.turns.slice(-5);
		return recent
			.map((t) => {
				const lines = [`Step ${t.stepNumber} — ${t.reasoning}`];
				for (let i = 0; i < t.actions.length; i++) {
					const a = t.actions[i];
					const r = t.results[i];
					const tag = r ? (r.result === 'ok' ? '✓' : `✗ ${r.error ?? 'failed'}`) : '·';
					lines.push(`  ${tag} ${a.variant}${renderActionArgs(a)}`);
				}
				return lines.join('\n');
			})
			.join('\n');
	}

	// Last batch's results, attached to the next observation so the model
	// can immediately see what just happened.
	lastResults(): AgentActionResult[] | undefined {
		const last = this.turns.at(-1);
		return last ? last.results : undefined;
	}
}

function renderActionArgs(action: AgentAction): string {
	switch (action.variant) {
		case 'mouse:click':
		case 'mouse:double_click':
		case 'mouse:right_click':
			return ` (${action.x}, ${action.y})`;
		case 'mouse:drag':
			return ` (${action.from.x},${action.from.y}) → (${action.to.x},${action.to.y})`;
		case 'mouse:scroll':
			return ` @ (${action.x}, ${action.y}) Δ(${action.deltaX}, ${action.deltaY})`;
		case 'page:read':
			return ` box(${action.x}, ${action.y}, ${action.width}×${action.height})`;
		case 'keyboard:type':
			return ` "${action.content.length > 40 ? action.content.slice(0, 40) + '…' : action.content}"`;
		case 'browser:nav':
			return ` ${action.url}`;
		case 'browser:tab:switch':
			return ` index=${action.index}`;
		case 'wait':
			return ` ${action.seconds}s`;
		case 'task:done':
			return ` "${action.evidence.slice(0, 80)}"`;
		case 'task:fail':
			return ` "${action.reason.slice(0, 80)}"`;
		default:
			return '';
	}
}
