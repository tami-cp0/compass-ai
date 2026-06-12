import { v4 as uuidv4 } from 'uuid';
import type {
	AgentAction,
	AgentActionResult,
	ExtensionMessage,
	SessionState,
	Task,
} from '@compass-ai/types';
import type { GeminiLiveSession } from '../agents/conversation/gemini-live-session.js';
import { runResearchAgent } from '../agents/research/research-agent.js';
import { runWebAgentStep, type WebObservation } from '../agents/web/web-step.js';
import { WebAgentMemory } from '../agents/web/web-memory.js';
import { sessionLogger, type Logger } from '../infra/logger.js';
import { TokenTracker } from '../infra/token-tracker.js';
import { nowReadableWAT } from '../infra/datetime.js';

export interface SessionMetrics {
	researchDispatched: number;
	researchCompleted: number;
	researchFailed: number;
	automationDispatched: number;
	automationCompleted: number;
	automationFailed: number;
	automationSteps: number;
}

// Variants that terminate the loop. Anything after one of these in the same
// batch is silently dropped.
const TERMINAL_VARIANTS = new Set(['task:done', 'task:fail']);

// Per-variant action timeouts (ms). Heavy SPAs can take 20s+ to settle after
// navigation, so we give those a longer leash than mouse/keyboard inputs.
const NAV_VARIANTS = new Set(['browser:nav', 'browser:nav:back', 'browser:tab:switch', 'browser:tab:new']);
const NAV_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 20_000;

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
	private pendingObservations = new Map<
		string,
		(msg: Extract<ExtensionMessage, { type: 'agent_observation' }> | null) => void
	>();
	private pendingActionResults = new Map<
		string,
		(msg: Extract<ExtensionMessage, { type: 'agent_action_result' }> | null) => void
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
		const slotIndex = this.session.researchSlots.findIndex((s) => s === null);
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
			free_research_slots_remaining:
				this.session.researchSlots.filter((s) => s === null).length - 1,
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
				(this.session.researchSlots as Array<Task | null>)[slotIndex] = null;
				this.abortControllers.delete(taskId);
				this.tokens.recordResearch(taskId, name, usage);
				const body = JSON.stringify(result);
				const MAX = 10_000;
				const trimmed = body.length > MAX ? body.slice(0, MAX) + '\n[...truncated]' : body;
				const payload = `[research_result: ${name}]\nCompleted at: ${nowReadableWAT()}\n${trimmed}`;
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
				(this.session.researchSlots as Array<Task | null>)[slotIndex] = null;
				this.abortControllers.delete(taskId);
				const error = err instanceof Error ? err : new Error(String(err));
				this.gemini.injectContent(
					`[research error] Task "${name}" failed: ${error.message}\nFailed at: ${nowReadableWAT()}`
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

	dispatchAutomation(name: string, description: string): Record<string, unknown> {
		if (this.session.automationSlot !== null) {
			return {
				status: 'rejected',
				reason: 'automation_slot_full',
				free_automation_slots_remaining: 0,
			};
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

	handleAgentObservation(
		msg: Extract<ExtensionMessage, { type: 'agent_observation' }>
	): void {
		const resolve = this.pendingObservations.get(msg.taskId);
		if (resolve) {
			this.pendingObservations.delete(msg.taskId);
			resolve(msg);
		}
	}

	handleAgentActionResult(
		msg: Extract<ExtensionMessage, { type: 'agent_action_result' }>
	): void {
		const resolve = this.pendingActionResults.get(msg.actionId);
		if (resolve) {
			this.pendingActionResults.delete(msg.actionId);
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

	private _requestObservation(
		taskId: string
	): Promise<Extract<ExtensionMessage, { type: 'agent_observation' }> | null> {
		this.session.send({
			type: 'agent_observation_request',
			sessionId: this.session.sessionId,
			taskId,
		});

		return new Promise((resolve) => {
			this.pendingObservations.set(taskId, resolve);

			setTimeout(() => {
				if (this.pendingObservations.has(taskId)) {
					this.pendingObservations.delete(taskId);
					resolve(null);
				}
			}, 15_000);
		});
	}

	private async _executeAction(
		taskId: string,
		action: AgentAction
	): Promise<{ success: boolean; error?: string }> {
		const actionId = uuidv4();
		const sessionId = this.session.sessionId;

		this.session.send({
			type: 'agent_action',
			sessionId,
			taskId,
			actionId,
			action,
		});

		const timeoutMs = NAV_VARIANTS.has(action.variant)
			? NAV_ACTION_TIMEOUT_MS
			: DEFAULT_ACTION_TIMEOUT_MS;

		const result = await new Promise<Extract<
			ExtensionMessage,
			{ type: 'agent_action_result' }
		> | null>((resolve) => {
			this.pendingActionResults.set(actionId, resolve);
			setTimeout(() => {
				if (this.pendingActionResults.has(actionId)) {
					this.pendingActionResults.delete(actionId);
					resolve(null);
				}
			}, timeoutMs);
		});

		if (!result) {
			return { success: false, error: `Action timed out after ${timeoutMs / 1000}s` };
		}
		return { success: result.success, error: result.error };
	}

	private _runAutomation(task: Task): void {
		const { taskId, name, description } = task;
		const memory = new WebAgentMemory(description);

		this._runAutomationLoop(task, memory).catch((err: unknown) => {
			this.pendingObservations.delete(taskId);
			if (this.session.cancelledTasks.has(taskId)) {
				this.log.debug('Automation error discarded — task was cancelled', { taskId });
				return;
			}
			this.session.automationSlot = null;
			this.abortControllers.delete(taskId);
			const error = err instanceof Error ? err : new Error(String(err));
			this._sendAutomationEnd(taskId, 'error', error.message);
			const progressLog = memory.renderProgressLog();
			const logSegment = progressLog ? `\n${progressLog}` : '';
			this.gemini.injectContent(
				`[automation context] Task "${name}" failed: ${error.message}\nFailed at: ${nowReadableWAT()}\nGoal: ${description}${logSegment}\nautomation_slot_freed: true`
			);
			this.metrics.automationFailed++;
			this.log.error('Automation failed', {
				taskId,
				name,
				durationMs: Date.now() - task.startedAt,
				error,
			});
		});
	}

	private async _runAutomationLoop(task: Task, memory: WebAgentMemory): Promise<void> {
		const { taskId, name, description } = task;
		const MAX_STEPS = 20;

		while (memory.stepCount < MAX_STEPS) {
			if (this._isCancelled(taskId, task, 'before observation', memory.stepCount)) return;

			const obsMsg = await this._requestObservation(taskId);

			if (this._isCancelled(taskId, task, 'after observation', memory.stepCount)) return;

			if (!obsMsg) {
				this._failAutomation(
					task,
					memory,
					`Observation timed out at step ${memory.stepCount + 1}`,
					'observation_timeout',
					memory.stepCount
				);
				return;
			}

			const observation: WebObservation = {
				screenshot: obsMsg.screenshot,
				width: obsMsg.width,
				height: obsMsg.height,
				url: obsMsg.url,
				title: obsMsg.title,
			};

			const { step, usage } = await runWebAgentStep(memory, observation);
			this.tokens.recordAutomationStep(taskId, name, memory.stepCount + 1, usage);

			if (this._isCancelled(taskId, task, 'after agent step', memory.stepCount)) return;

			const results: AgentActionResult[] = [];
			let terminal: AgentAction | null = null;

			for (const action of step.actions) {
				if (TERMINAL_VARIANTS.has(action.variant)) {
					terminal = action;
					break;
				}

				const result = await this._executeAction(taskId, action);
				results.push({
					variant: action.variant,
					result: result.success ? 'ok' : 'failed',
					...(result.error ? { error: result.error } : {}),
				});
				this.metrics.automationSteps++;

				this.log.debug('Action executed', {
					taskId,
					step: memory.stepCount + 1,
					variant: action.variant,
					success: result.success,
					error: result.error,
				});

				if (this._isCancelled(taskId, task, 'after action', memory.stepCount)) return;

				if (!result.success) {
					// First failure ends the batch — agent sees the failure next turn.
					break;
				}
			}

			memory.recordTurn(step.reasoning, step.progress_note, step.actions, results);

			if (terminal) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);

				const progressLog = memory.renderProgressLog();

				if (terminal.variant === 'task:done') {
					this._sendAutomationEnd(taskId, 'complete');
					this.gemini.injectContent(
						`[automation context] Task "${name}" completed in ${memory.stepCount} step(s).\nCompleted at: ${nowReadableWAT()}\nGoal: ${description}\n${progressLog}\nEvidence: ${terminal.evidence}\nautomation_slot_freed: true`
					);
					this.metrics.automationCompleted++;
					this.log.info('Automation completed', {
						taskId,
						name,
						steps: memory.stepCount,
						durationMs: Date.now() - task.startedAt,
					});
				} else if (terminal.variant === 'task:fail') {
					this._sendAutomationEnd(taskId, 'error', terminal.reason);
					this.gemini.injectContent(
						`[automation context] Task "${name}" could not be completed after ${memory.stepCount} step(s): ${terminal.reason}\nFailed at: ${nowReadableWAT()}\nGoal: ${description}\n${progressLog}\nautomation_slot_freed: true`
					);
					this.metrics.automationFailed++;
					this.log.error('Automation failed', {
						taskId,
						name,
						reason: 'agent_declared_failure',
						step: memory.stepCount,
						declaredReason: terminal.reason,
						durationMs: Date.now() - task.startedAt,
					});
				}
				return;
			}

			// Mid-run heartbeat every 2 completed steps. Silent context only —
			// Gemini gets the running summary without being prompted to narrate.
			// Tagged as a heartbeat so successive ticks coalesce in the inject
			// queue: if the model was speaking through several steps, only the
			// most recent heartbeat for this task flushes.
			if (memory.stepCount % 2 === 0) {
				const recent = memory.recentProgressNotes(2)
					.map((p) => `Step ${p.stepNumber}: ${p.note}`)
					.join('\n');
				this.gemini.injectContent(
					`[automation in progress] Task "${name}" — step ${memory.stepCount}/${MAX_STEPS}.\nGoal: ${description}\n${recent}`,
					{ kind: 'heartbeat', key: `automation:${taskId}` }
				);
			}
		}

		this._failAutomation(
			task,
			memory,
			`Exceeded maximum steps (${MAX_STEPS})`,
			'max_steps_exceeded',
			memory.stepCount
		);
	}

	private _failAutomation(
		task: Task,
		memory: WebAgentMemory,
		errorMsg: string,
		reason: string,
		steps: number
	): void {
		const { taskId, name, description } = task;
		this.session.automationSlot = null;
		this.abortControllers.delete(taskId);
		this._sendAutomationEnd(taskId, 'error', errorMsg);
		const progressLog = memory.renderProgressLog();
		const logSegment = progressLog ? `\n${progressLog}` : '';
		this.gemini.injectContent(
			`[automation context] Task "${name}" failed: ${errorMsg}\nFailed at: ${nowReadableWAT()}\nGoal: ${description}${logSegment}\nautomation_slot_freed: true`
		);
		this.metrics.automationFailed++;
		this.log.error('Automation failed', {
			taskId,
			name,
			reason,
			steps,
			durationMs: Date.now() - task.startedAt,
		});
	}

	private _isCancelled(
		taskId: string,
		task: Task,
		stage: string,
		steps: number
	): boolean {
		if (!this.session.cancelledTasks.has(taskId)) return false;
		this.session.automationSlot = null;
		this.abortControllers.delete(taskId);
		this._sendAutomationEnd(taskId, 'cancelled');
		this.log.info('Automation cancelled', {
			taskId,
			name: task.name,
			durationMs: Date.now() - task.startedAt,
			steps,
			after: stage,
		});
		return true;
	}

	cancel(name: string): Record<string, unknown> {
		const researchSlotIndex = this.session.researchSlots.findIndex(
			(s) => s?.name === name
		);
		const automationMatch =
			this.session.automationSlot?.name === name ? this.session.automationSlot : null;

		const task =
			researchSlotIndex !== -1
				? this.session.researchSlots[researchSlotIndex]
				: automationMatch;

		if (!task) {
			return { status: 'not_found', reason: 'no_running_task_with_that_name' };
		}

		const taskId = task.taskId;
		this.session.cancelledTasks.add(taskId);
		this.abortControllers.get(taskId)?.abort();
		this.abortControllers.delete(taskId);

		const observationResolve = this.pendingObservations.get(taskId);
		if (observationResolve) {
			this.pendingObservations.delete(taskId);
			observationResolve(null);
		}

		for (const [actionId, resolve] of this.pendingActionResults) {
			resolve(null);
			this.pendingActionResults.delete(actionId);
		}

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
