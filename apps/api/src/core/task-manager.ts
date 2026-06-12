import { v4 as uuidv4 } from 'uuid';
import type {
	ExtensionMessage,
	SessionState,
	StepRecord,
	Task,
	WebAction,
	WebIntent,
} from '@compass-ai/types';
import type { GeminiLiveSession } from '../agents/conversation/gemini-live-session.js';
import { runResearchAgent } from '../agents/research/research-agent.js';
import { webAgentNextStep } from '../agents/web/web-agent.js';
import { sessionLogger, type Logger } from '../infra/logger.js';
import { TokenTracker } from '../infra/token-tracker.js';

export interface SessionMetrics {
	researchDispatched: number;
	researchCompleted: number;
	researchFailed: number;
	automationDispatched: number;
	automationCompleted: number;
	automationFailed: number;
	automationSteps: number;
}

export class TaskManager {
	private session: SessionState;
	private gemini: GeminiLiveSession;
	private log!: Logger;
	readonly tokens: TokenTracker;
	private abortControllers: Map<string, AbortController> = new Map();
	readonly metrics: SessionMetrics = {
		researchDispatched: 0,
		researchCompleted: 0,
		researchFailed: 0,
		automationDispatched: 0,
		automationCompleted: 0,
		automationFailed: 0,
		automationSteps: 0,
	};
	private pendingSnapshots = new Map<
		string,
		(
			msg: Extract<ExtensionMessage, { type: 'dom_snapshot' }> | null
		) => void
	>();
	private pendingActionResults = new Map<
		string,
		(
			msg: Extract<ExtensionMessage, { type: 'action_result' }> | null
		) => void
	>();
	private pendingUserActionResults = new Map<
		string,
		(
			msg: Extract<
				ExtensionMessage,
				{ type: 'user_action_result' }
			> | null
		) => void
	>();
	private pendingScreenshots = new Map<string, (dataUrl: string) => void>();

	constructor(session: SessionState, gemini: GeminiLiveSession) {
		this.session = session;
		this.gemini = gemini;
		this.log = sessionLogger(session.sessionId);
		this.tokens = new TokenTracker(session.sessionId);
		gemini.setTokenTracker(this.tokens);
		gemini.onRequestScreenshot = () => this._requestScreenshot();
	}

	dispatchResearch(
		name: string,
		description: string,
		profile: 'stock_analysis' | 'general_research'
	): Record<string, unknown> {
		const slotIndex = this.session.researchSlots.findIndex(
			(s) => s === null
		);
		if (slotIndex === -1) {
			return { status: 'rejected', reason: 'research_slots_full', free_research_slots_remaining: 0 };
		}

		const taskId = uuidv4();
		const task: Task = {
			taskId,
			type: 'research',
			name,
			description,
			status: 'running',
			startedAt: Date.now(),
		};
		this.session.researchSlots[slotIndex] = task;

		const controller = new AbortController();
		this.abortControllers.set(taskId, controller);

		this.metrics.researchDispatched++;
		this.log.info('Research dispatched', { taskId, name, profile });

		this._runResearch(task, slotIndex, profile, controller.signal);

		return {
			taskId,
			status: 'dispatched',
			free_research_slots_remaining: this.session.researchSlots.filter(s => s === null).length - 1,
		};
	}

	private _runResearch(
		task: Task,
		slotIndex: number,
		profile: 'stock_analysis' | 'general_research',
		signal: AbortSignal
	): void {
		const { taskId, name, description } = task;

		runResearchAgent(profile, description, signal)
			.then(({ result, usage }) => {
				if (this.session.cancelledTasks.has(taskId)) {
					this.log.debug('Research result discarded — task was cancelled', { taskId });
					return;
				}
				(this.session.researchSlots as Array<Task | null>)[slotIndex] =
					null;
				this.abortControllers.delete(taskId);
				this.tokens.recordResearch(taskId, name, usage);
				const body = JSON.stringify(result);
				const MAX = 10_000;
				const trimmed =
					body.length > MAX
						? body.slice(0, MAX) + '\n[...truncated]'
						: body;
				const payload = `[research_result: ${name}]\n${trimmed}`;
				this.gemini.injectContent(payload);
				this.metrics.researchCompleted++;
				this.log.info('Research completed', {
					taskId,
					name,
					durationMs: Date.now() - task.startedAt,
					byteLength: body.length,
					truncated: body.length > MAX,
				});
			})
			.catch((err: unknown) => {
				if (this.session.cancelledTasks.has(taskId)) {
					this.log.debug('Research error discarded — task was cancelled', { taskId });
					return;
				}
				(this.session.researchSlots as Array<Task | null>)[slotIndex] =
					null;
				this.abortControllers.delete(taskId);
				const error = err instanceof Error ? err : new Error(String(err));
				this.gemini.injectContent(
					`[research error] Task "${name}" failed: ${error.message}`
				);
				this.metrics.researchFailed++;
				this.log.error('Research failed', {
					taskId,
					name,
					durationMs: Date.now() - task.startedAt,
					error,
				});
			});
	}

	dispatchAutomation(
		name: string,
		description: string
	): Record<string, unknown> {
		if (this.session.automationSlot !== null) {
			return { status: 'rejected', reason: 'automation_slot_full', free_automation_slots_remaining: 0 };
		}

		const taskId = uuidv4();
		const task: Task = {
			taskId,
			type: 'automation',
			name,
			description,
			status: 'running',
			startedAt: Date.now(),
		};
		this.session.automationSlot = task;

		const controller = new AbortController();
		this.abortControllers.set(taskId, controller);

		this.metrics.automationDispatched++;
		this.log.info('Automation dispatched', { taskId, name });

		this._runAutomation(task);

		return { taskId, status: 'dispatched', free_automation_slots_remaining: 0 };
	}

	handleDomSnapshot(
		msg: Extract<ExtensionMessage, { type: 'dom_snapshot' }>
	): void {
		const resolve = this.pendingSnapshots.get(msg.taskId);
		if (resolve) {
			this.pendingSnapshots.delete(msg.taskId);
			resolve(msg);
		}
	}

	handleActionResult(
		msg: Extract<ExtensionMessage, { type: 'action_result' }>
	): void {
		const resolve = this.pendingActionResults.get(msg.actionId);
		if (resolve) {
			this.pendingActionResults.delete(msg.actionId);
			resolve(msg);
		}
	}

	handleUserActionResult(
		msg: Extract<ExtensionMessage, { type: 'user_action_result' }>
	): void {
		const resolve = this.pendingUserActionResults.get(msg.actionId);
		if (resolve) {
			this.pendingUserActionResults.delete(msg.actionId);
			resolve(msg);
		}
	}

	handleScreenshotResponse(
		msg: Extract<ExtensionMessage, { type: 'screenshot_response' }>
	): void {
		const resolve = this.pendingScreenshots.get(msg.requestId);
		if (resolve) {
			this.pendingScreenshots.delete(msg.requestId);
			resolve(msg.dataUrl);
		}
	}

	private _requestScreenshot(): Promise<string> {
		const requestId = uuidv4();
		this.session.send({
			type: 'screenshot_request',
			sessionId: this.session.sessionId,
			requestId,
		});

		return new Promise<string>((resolve) => {
			this.pendingScreenshots.set(requestId, resolve);

			setTimeout(() => {
				if (this.pendingScreenshots.has(requestId)) {
					this.pendingScreenshots.delete(requestId);
					resolve('');
				}
			}, 10_000);
		});
	}

	private _sendAutomationEnd(
		taskId: string,
		reason: 'complete' | 'cancelled' | 'error',
		error?: string
	): void {
		this.session.send({
			type: 'automation_end',
			sessionId: this.session.sessionId,
			taskId,
			reason,
			...(error ? { error } : {}),
		});
	}

	private _requestSnapshot(
		taskId: string
	): Promise<Extract<ExtensionMessage, { type: 'dom_snapshot' }> | null> {
		this.session.send({
			type: 'dom_snapshot_request',
			sessionId: this.session.sessionId,
			taskId,
			taskType: 'structure',
		});

		return new Promise((resolve) => {
			this.pendingSnapshots.set(taskId, resolve);

			setTimeout(() => {
				if (this.pendingSnapshots.has(taskId)) {
					this.pendingSnapshots.delete(taskId);
					resolve(null);
				}
			}, 10_000);
		});
	}

	private _buildIntent(
		action: WebAction
	): { ok: true; intent: WebIntent } | { ok: false; error: string } {
		const { action: verb, element_id, value, direction, amount, text_snippet, key } = action;

		if (verb === 'click') {
			if (element_id == null) return { ok: false, error: 'click requires a valid element_id (got null)' };
			if (value != null) return { ok: false, error: `click cannot carry a value (got "${value}"). To enter text use action: "type".` };
			if (text_snippet != null) return { ok: false, error: 'click cannot carry text_snippet. To select text inside an element use action: "highlight".' };
			if (direction != null || amount != null) return { ok: false, error: 'click cannot carry direction/amount. To scroll use action: "scroll".' };
			if (key != null) return { ok: false, error: 'click cannot carry key. To press a keyboard key use action: "press".' };
			return { ok: true, intent: { action: 'click', element_id } };
		}

		if (verb === 'type') {
			if (element_id == null) return { ok: false, error: 'type requires a valid element_id from the map' };
			if (value == null || value === '') return { ok: false, error: 'type requires a non-empty value string' };
			if (direction != null || amount != null || text_snippet != null || key != null) return { ok: false, error: 'type cannot carry direction/amount/text_snippet/key' };
			return { ok: true, intent: { action: 'type', element_id, value } };
		}

		if (verb === 'scroll') {
			if (element_id == null) return { ok: false, error: 'scroll requires element_id of a ScrollContainer from the map (use the [N] ScrollContainer entry for the panel you want to scroll — bid, offer, trades, securities grid, etc. each have their own)' };
			if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
				return { ok: false, error: `scroll requires direction in {up,down,left,right} (got ${JSON.stringify(direction)})` };
			}
			if (amount == null || amount <= 0) return { ok: false, error: 'scroll requires a positive amount (in pixels)' };
			if (value != null || text_snippet != null || key != null) return { ok: false, error: 'scroll cannot carry value/text_snippet/key' };
			return { ok: true, intent: { action: 'scroll', element_id, direction, amount } };
		}

		if (verb === 'highlight') {
			if (element_id == null) return { ok: false, error: 'highlight requires a valid element_id from the map' };
			if (text_snippet == null || text_snippet === '') return { ok: false, error: 'highlight requires a non-empty text_snippet to locate' };
			if (value != null || direction != null || amount != null || key != null) return { ok: false, error: 'highlight cannot carry value/direction/amount/key' };
			return { ok: true, intent: { action: 'highlight', element_id, text_snippet } };
		}

		if (verb === 'press') {
			if (element_id == null) return { ok: false, error: 'press requires a valid element_id to target (the element that should receive the key event — typically the input you just typed into)' };
			const allowed = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
			if (key == null || !(allowed as readonly string[]).includes(key)) {
				return { ok: false, error: `press requires key in {${allowed.join(',')}} (got ${JSON.stringify(key)})` };
			}
			if (value != null || direction != null || amount != null || text_snippet != null) return { ok: false, error: 'press cannot carry value/direction/amount/text_snippet' };
			return { ok: true, intent: { action: 'press', element_id, key } };
		}

		return { ok: false, error: `unknown action verb "${verb}" — must be one of click|type|scroll|highlight|press` };
	}

	private async _executeAction(
		taskId: string,
		action: WebAction
	): Promise<{ success: boolean; error?: string }> {
		const actionId = uuidv4();
		const sessionId = this.session.sessionId;

		const built = this._buildIntent(action);
		if (!built.ok) {
			return { success: false, error: built.error };
		}
		const intent = built.intent;

		if (action.isCritical) {
			this.session.send({
				type: 'user_action_required',
				sessionId,
				actionId,
				taskId,
				description: action.description,
			});

			const userResult = await new Promise<Extract<
				ExtensionMessage,
				{ type: 'user_action_result' }
			> | null>((resolve) => {
				this.pendingUserActionResults.set(actionId, resolve);
				setTimeout(() => {
					if (this.pendingUserActionResults.has(actionId)) {
						this.pendingUserActionResults.delete(actionId);
						resolve(null);
					}
				}, 120_000);
			});

			if (!userResult) {
				return { success: false, error: 'User confirmation timed out' };
			}
			if (!userResult.confirmed) {
				return { success: false, error: 'User declined the action' };
			}
		}

		this.session.send({
			type: 'action',
			sessionId,
			actionId,
			taskId,
			intent,
			isCritical: action.isCritical,
		});

		const result = await new Promise<Extract<
			ExtensionMessage,
			{ type: 'action_result' }
		> | null>((resolve) => {
			this.pendingActionResults.set(actionId, resolve);
			setTimeout(() => {
				if (this.pendingActionResults.has(actionId)) {
					this.pendingActionResults.delete(actionId);
					resolve(null);
				}
			}, 15_000);
		});

		if (!result) {
			return { success: false, error: 'Action timed out after 15s' };
		}
		return { success: result.success, error: result.error };
	}

	private _formatStepSummary(history: StepRecord[]): string {
		if (history.length === 0) return '';
		const recent = history.slice(-3);
		return '\nLast steps: ' + recent.map(s => `[${s.step_number}] ${s.action_description} → ${s.outcome}`).join(' | ');
	}

	private _injectAutomationContext(message: string, history: StepRecord[] = []): void {
		const stepSummary = this._formatStepSummary(history);
		this.gemini.injectContent(`${message}${stepSummary}\nautomation_slot_freed: true`);
	}

	private _runAutomation(task: Task): void {
		const { taskId, name } = task;

		this._runAutomationLoop(task, []).catch((err: unknown) => {
			this.pendingSnapshots.delete(taskId);
			if (this.session.cancelledTasks.has(taskId)) {
				this.log.debug('Automation error discarded — task was cancelled', { taskId });
				return;
			}
			this.session.automationSlot = null;
			this.abortControllers.delete(taskId);
			const error = err instanceof Error ? err : new Error(String(err));
			this._sendAutomationEnd(taskId, 'error', error.message);
			this._injectAutomationContext(`[automation context] Task "${name}" failed: ${error.message}`);
			this.metrics.automationFailed++;
			this.log.error('Automation failed', {
				taskId,
				name,
				durationMs: Date.now() - task.startedAt,
				error,
			});
		});
	}

	private async _runAutomationLoop(
		task: Task,
		history: StepRecord[]
	): Promise<void> {
		const { taskId, name, description } = task;
		const MAX_STEPS = 20;

		while (history.length < MAX_STEPS) {
			if (this.session.cancelledTasks.has(taskId)) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'cancelled');
				this.log.info('Automation cancelled', { taskId, name, durationMs: Date.now() - task.startedAt, steps: history.length });
				return;
			}

			// Single round trip: snapshot returns screenshot + elementMap together
			const snapshot = await this._requestSnapshot(taskId);

			if (this.session.cancelledTasks.has(taskId)) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'cancelled');
				this.log.info('Automation cancelled', { taskId, name, durationMs: Date.now() - task.startedAt, steps: history.length, after: 'snapshot' });
				return;
			}

			if (!snapshot) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				const errorMsg = `DOM snapshot timed out at step ${history.length + 1}`;
				this._sendAutomationEnd(taskId, 'error', errorMsg);
				this._injectAutomationContext(`[automation context] Task "${name}" failed: ${errorMsg}`, history);
				this.metrics.automationFailed++;
				this.log.error('Automation failed', { taskId, name, reason: 'snapshot_timeout', step: history.length + 1, durationMs: Date.now() - task.startedAt });
				return;
			}

			const recentHistory = history.slice(-10);
			const { step, usage } = await webAgentNextStep(description, snapshot.elementMap, snapshot.screenshot, recentHistory);
			this.tokens.recordAutomationStep(taskId, name, history.length + 1, usage);

			if (this.session.cancelledTasks.has(taskId)) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'cancelled');
				this.log.info('Automation cancelled', { taskId, name, durationMs: Date.now() - task.startedAt, steps: history.length, after: 'agent_step' });
				return;
			}

			if (step.is_failed) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				const errorMsg = step.reasoning;
				this._sendAutomationEnd(taskId, 'error', errorMsg);
				this._injectAutomationContext(`[automation context] Task "${name}" could not be completed after ${history.length} step(s): ${errorMsg}`, history);
				this.metrics.automationFailed++;
				this.log.error('Automation failed', { taskId, name, reason: 'agent_declared_failure', step: history.length + 1, reasoning: errorMsg, durationMs: Date.now() - task.startedAt });
				return;
			}

			if (step.is_complete) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'complete');
				this._injectAutomationContext(`[automation context] Task "${name}" completed in ${history.length} step(s).`);
				this.metrics.automationCompleted++;
				this.log.info('Automation completed', { taskId, name, steps: history.length, durationMs: Date.now() - task.startedAt });
				return;
			}

			if (!step.next_action) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'error', 'Agent returned no action and did not declare completion');
				this._injectAutomationContext(`[automation context] Task "${name}" failed: agent returned no action`, history);
				this.metrics.automationFailed++;
				this.log.error('Automation failed', { taskId, name, reason: 'agent_returned_no_action', durationMs: Date.now() - task.startedAt });
				return;
			}

			const action = step.next_action;
			const result = await this._executeAction(taskId, action);

			const stepRecord: StepRecord = {
				step_number: history.length + 1,
				action_description: action.description,
				outcome: result.success ? 'succeeded' : 'failed',
				...(result.success ? {} : { error: result.error ?? 'unknown error' }),
			};
			history.push(stepRecord);
			this.metrics.automationSteps++;

			this.gemini.injectContent(
				`[automation context] Task "${name}" step ${stepRecord.step_number}: ${stepRecord.action_description} → ${stepRecord.outcome}`
			);

			this.log.debug('Action executed', {
				taskId,
				step: history.length,
				action: action.action,
				elementId: action.element_id,
				success: result.success,
				error: result.error,
			});

			if (this.session.cancelledTasks.has(taskId)) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'cancelled');
				this.log.info('Automation cancelled', { taskId, name, durationMs: Date.now() - task.startedAt, steps: history.length, after: 'action' });
				return;
			}

			if (!result.success) {
				// Don't abort — let agent see the new state and decide
				this.log.debug('Action failed, agent will decide next step', {
					taskId,
					step: history.length,
					error: result.error,
				});
			}
		}

		// Exceeded max steps
		this.session.automationSlot = null;
		this.abortControllers.delete(taskId);
		this._sendAutomationEnd(taskId, 'error', `Exceeded maximum steps (${MAX_STEPS})`);
		this._injectAutomationContext(`[automation context] Task "${name}" aborted after ${MAX_STEPS} steps without completing`, history);
		this.metrics.automationFailed++;
		this.log.error('Automation failed', { taskId, name, reason: 'max_steps_exceeded', maxSteps: MAX_STEPS, durationMs: Date.now() - task.startedAt });
	}

	cancel(name: string): Record<string, unknown> {
		// Find the task by name across all slots
		const researchSlotIndex = this.session.researchSlots.findIndex(
			(s) => s?.name === name
		);
		const automationMatch = this.session.automationSlot?.name === name
			? this.session.automationSlot
			: null;

		const task = researchSlotIndex !== -1
			? this.session.researchSlots[researchSlotIndex]
			: automationMatch;

		if (!task) {
			return { status: 'not_found', reason: 'no_running_task_with_that_name' };
		}

		const taskId = task.taskId;
		this.session.cancelledTasks.add(taskId);
		this.abortControllers.get(taskId)?.abort();
		this.abortControllers.delete(taskId);

		// Unblock any pending snapshot — _runAutomation will see cancelledTasks and clean up the slot
		const snapshotResolve = this.pendingSnapshots.get(taskId);
		if (snapshotResolve) {
			this.pendingSnapshots.delete(taskId);
			snapshotResolve(null);
		}

		// Unblock all pending action results (keyed by actionId, not taskId — clear all)
		for (const [actionId, resolve] of this.pendingActionResults) {
			resolve(null);
			this.pendingActionResults.delete(actionId);
		}

		// Unblock all pending user-action results
		for (const [actionId, resolve] of this.pendingUserActionResults) {
			resolve(null);
			this.pendingUserActionResults.delete(actionId);
		}

		// Unblock all pending screenshot requests
		for (const [requestId, resolve] of this.pendingScreenshots) {
			resolve('');
			this.pendingScreenshots.delete(requestId);
		}

		if (researchSlotIndex !== -1) {
			(this.session.researchSlots as Array<Task | null>)[researchSlotIndex] = null;
		}

		this.log.info('Task cancelled', { taskId, name });
		return { status: 'cancelled', name };
	}
}
