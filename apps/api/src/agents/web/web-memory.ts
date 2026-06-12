import type { AgentAction, AgentActionResult } from '@compass-ai/types';

// Lightweight memory for the web agent loop. Holds the task goal plus a
// rolling window of recent reasonings and the last screenshot/tab so the
// model has continuity across turns without paying for the full history.
//
// Why this is small: we only have one screenshot per turn, the model is
// vision-driven, and stuffing more than ~2 screenshots into the context
// quickly blows the token budget without measurable accuracy gain.

export interface MemoryTurn {
	stepNumber: number;
	reasoning: string;
	progressNote: string;
	actions: AgentAction[];
	results: AgentActionResult[];
}

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
		actions: AgentAction[],
		results: AgentActionResult[]
	): void {
		this.turns.push({
			stepNumber: this.turns.length + 1,
			reasoning,
			progressNote,
			actions,
			results,
		});
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
