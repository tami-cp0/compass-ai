import type Anthropic from '@anthropic-ai/sdk';
import type { AgentAction } from '@compass-ai/types';

// Memory for the web-agent loop. With native computer use the model's own
// conversation IS the memory, so we just hold the running Anthropic message
// list and a rolling record of the actions each turn emitted (for the
// no-progress circuit breaker and the externalized progress log).

export interface MemoryTurn {
	stepNumber: number;
	// The assistant's spoken text this turn (its reasoning / narration).
	text: string;
	actions: AgentAction[];
}

// Pointer actions that can spin without progress. Repeating an identical one is
// the loop signature we break on. Typing/navigation legitimately change state.
const LOOPABLE_VARIANTS = new Set<string>([
	'mouse:click',
	'mouse:double_click',
	'mouse:right_click',
	'mouse:scroll',
	'wait',
]);

export class WebAgentMemory {
	readonly goal: string;
	// The live Anthropic conversation. Grows by one assistant turn + one user
	// (tool_result) turn per step.
	readonly messages: Anthropic.Beta.BetaMessageParam[] = [];
	private turns: MemoryTurn[] = [];

	constructor(goal: string) {
		this.goal = goal;
	}

	get stepCount(): number {
		return this.turns.length;
	}

	recordTurn(text: string, actions: AgentAction[]): void {
		this.turns.push({ stepNumber: this.turns.length + 1, text, actions });
	}

	// A batch is a no-op repeat when it and the previous batch are the same
	// loopable pointer action at (nearly) the same spot. Two of these in a row =
	// the model is stuck nudging a dead element. Computed from emitted actions,
	// not a self-reported flag.
	get noProgressStreak(): number {
		let streak = 0;
		for (let i = this.turns.length - 1; i >= 1; i--) {
			if (this.isRepeat(this.turns[i].actions, this.turns[i - 1].actions)) streak++;
			else break;
		}
		return streak;
	}

	private isRepeat(a: AgentAction[], b: AgentAction[]): boolean {
		if (a.length !== 1 || b.length !== 1) return false;
		const x = a[0];
		const y = b[0];
		if (x.variant !== y.variant || !LOOPABLE_VARIANTS.has(x.variant)) return false;
		if ('x' in x && 'y' in y && 'x' in y) {
			return Math.abs(x.x - y.x) <= 8 && Math.abs(x.y - y.y) <= 8;
		}
		return true;
	}

	// One-line-per-step progress log for the orchestrating model.
	renderProgressLog(): string {
		return this.turns
			.map((t) => `Step ${t.stepNumber}: ${t.text || describeActions(t.actions)}`)
			.join('\n');
	}

	// Last N turns' narration for mid-run heartbeats.
	recentProgressNotes(count: number): { stepNumber: number; note: string }[] {
		return this.turns.slice(-count).map((t) => ({
			stepNumber: t.stepNumber,
			note: t.text || describeActions(t.actions),
		}));
	}
}

function describeActions(actions: AgentAction[]): string {
	if (actions.length === 0) return '(no action)';
	return actions.map((a) => a.variant).join(', ');
}
