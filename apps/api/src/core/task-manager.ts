import { v4 as uuidv4 } from 'uuid';
import type {
	ExtensionMessage,
	SessionState,
	Task,
	WebIntent,
} from '@compass-ai/types';
import type { StepRecord, WebAction } from '../../baml_client/types.js';
import type { GeminiLiveSession } from '../agents/conversation/gemini-live-session.js';
import { getConversationHistory } from '../infra/redis.js';
import { runResearchAgent } from '../agents/research/research-agent.js';
import { dataUrlToImage, webAgentNextStep } from '../agents/web/web-agent.js';
import { logger } from '../infra/logger.js';

export class TaskManager {
	private session: SessionState;
	private gemini: GeminiLiveSession;
	private abortControllers: Map<string, AbortController> = new Map();
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
		gemini.onRequestScreenshot = () => this._requestScreenshot();
	}

	dispatchResearch(
		name: string,
		description: string
	): Record<string, unknown> {
		const slotIndex = this.session.researchSlots.findIndex(
			(s) => s === null
		);
		if (slotIndex === -1) {
			return { status: 'rejected', reason: 'research_slots_full' };
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

		this._runResearch(task, slotIndex, controller.signal);

		return { taskId, status: 'dispatched' };
	}

	private _runResearch(
		task: Task,
		slotIndex: number,
		signal: AbortSignal
	): void {
		const { taskId, name, description } = task;
		const sessionId = this.session.sessionId;

		getConversationHistory(sessionId)
			.then((history) => {
				const context = history.recentTurns
					.slice(-3)
					.map(
						(t) =>
							`${t.role === 'user' ? 'User' : 'Compass'}: ${
								t.content
							}`
					)
					.join('\n');
				return runResearchAgent(description, context, signal);
			})
			.then((result) => {
				if (this.session.cancelledTasks.has(taskId)) {
					logger.info(
						'Research result discarded — task was cancelled',
						{ taskId }
					);
					return;
				}
				(this.session.researchSlots as Array<Task | null>)[slotIndex] =
					null;
				this.abortControllers.delete(taskId);
				const body = JSON.stringify(result);
				const MAX = 10_000;
				const trimmed =
					body.length > MAX
						? body.slice(0, MAX) + '\n[...truncated]'
						: body;
				const payload = `[research_result: ${name}]\n${trimmed}`;
				this.gemini.injectContent(payload);
				logger.info('Research result injected', {
					taskId,
					name,
					byteLength: body.length,
					truncated: body.length > MAX,
				});
			})
			.catch((err: unknown) => {
				if (this.session.cancelledTasks.has(taskId)) {
					logger.info(
						'Research error discarded — task was cancelled',
						{ taskId }
					);
					return;
				}
				(this.session.researchSlots as Array<Task | null>)[slotIndex] =
					null;
				this.abortControllers.delete(taskId);
				const message =
					err instanceof Error ? err.message : String(err);
				this.gemini.injectContent(
					`[research error] Task "${name}" failed: ${message}`
				);
				logger.error('Research task failed', {
					taskId,
					name,
					error: message,
				});
			});
	}

	dispatchAutomation(
		name: string,
		description: string
	): Record<string, unknown> {
		if (this.session.automationSlot !== null) {
			return { status: 'rejected', reason: 'automation_slot_full' };
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

		this._runAutomation(task);

		return { taskId, status: 'dispatched' };
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

	private _buildIntent(action: WebAction): WebIntent | null {
		if (action.action === 'click' && action.element_id != null) {
			return { action: 'click', element_id: action.element_id };
		}
		if (
			action.action === 'type' &&
			action.element_id != null &&
			action.value != null
		) {
			return {
				action: 'type',
				element_id: action.element_id,
				value: action.value,
			};
		}
		if (
			action.action === 'scroll' &&
			(action.direction === 'up' || action.direction === 'down') &&
			action.amount != null
		) {
			return {
				action: 'scroll',
				element_id: action.element_id ?? null,
				direction: action.direction,
				amount: action.amount,
			};
		}
		if (
			action.action === 'highlight' &&
			action.element_id != null &&
			action.text_snippet != null
		) {
			return {
				action: 'highlight',
				element_id: action.element_id,
				text_snippet: action.text_snippet,
			};
		}
		return null;
	}

	private async _executeAction(
		taskId: string,
		action: WebAction
	): Promise<{ success: boolean; error?: string }> {
		const actionId = uuidv4();
		const sessionId = this.session.sessionId;

		const intent = this._buildIntent(action);
		if (!intent) {
			return {
				success: false,
				error: `Cannot build intent for action "${action.action}" — missing required fields`,
			};
		}

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

	private _runAutomation(task: Task): void {
		const { taskId, name, description } = task;

		this._runAutomationLoop(task, []).catch((err: unknown) => {
			this.pendingSnapshots.delete(taskId);
			if (this.session.cancelledTasks.has(taskId)) {
				logger.info('Automation error discarded — task was cancelled', {
					taskId,
				});
				return;
			}
			this.session.automationSlot = null;
			this.abortControllers.delete(taskId);
			const message = err instanceof Error ? err.message : String(err);
			this._sendAutomationEnd(taskId, 'error', message);
			this.gemini.injectContent(
				`[automation context] Task "${name}" failed: ${message}`
			);
			logger.error('Automation task failed', {
				taskId,
				name,
				error: message,
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
				logger.info('Automation cancelled', { taskId, step: history.length });
				return;
			}

			// Wait for page to settle before capturing (skip on first step)
			if (history.length > 0) {
				await new Promise((r) => setTimeout(r, 800));
			}

			// Phase 1: screenshot only — cheap, no elementMap
			const screenshotUrl = await this._requestScreenshot();

			if (this.session.cancelledTasks.has(taskId)) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'cancelled');
				logger.info('Automation cancelled after screenshot', { taskId, step: history.length });
				return;
			}

			if (!screenshotUrl) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				const errorMsg = `Screenshot timed out at step ${history.length + 1}`;
				this._sendAutomationEnd(taskId, 'error', errorMsg);
				this.gemini.injectContent(`[automation context] Task "${name}" failed: ${errorMsg}`);
				logger.error('Automation screenshot timeout', { taskId, name, step: history.length + 1 });
				return;
			}

			const recentHistory = history.slice(-3);

			// Phase 2: recon call — screenshot only, no elementMap
			let step = await webAgentNextStep(description, null, screenshotUrl, recentHistory);

			if (this.session.cancelledTasks.has(taskId)) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'cancelled');
				logger.info('Automation cancelled after recon step', { taskId, step: history.length + 1 });
				return;
			}

			// Phase 3: if agent needs elementMap, fetch it and call again
			if (step.needs_element_map) {
				const snapshot = await this._requestSnapshot(taskId);

				if (this.session.cancelledTasks.has(taskId)) {
					this.session.automationSlot = null;
					this.abortControllers.delete(taskId);
					this._sendAutomationEnd(taskId, 'cancelled');
					logger.info('Automation cancelled while fetching elementMap', { taskId, step: history.length + 1 });
					return;
				}

				if (!snapshot) {
					this.session.automationSlot = null;
					this.abortControllers.delete(taskId);
					const errorMsg = `DOM snapshot timed out at step ${history.length + 1}`;
					this._sendAutomationEnd(taskId, 'error', errorMsg);
					this.gemini.injectContent(`[automation context] Task "${name}" failed: ${errorMsg}`);
					logger.error('Automation snapshot timeout', { taskId, name, step: history.length + 1 });
					return;
				}

				// Act call — same screenshot + real elementMap
				step = await webAgentNextStep(description, snapshot.elementMap, screenshotUrl, recentHistory);

				if (this.session.cancelledTasks.has(taskId)) {
					this.session.automationSlot = null;
					this.abortControllers.delete(taskId);
					this._sendAutomationEnd(taskId, 'cancelled');
					logger.info('Automation cancelled after act step', { taskId, step: history.length + 1 });
					return;
				}

				if (step.needs_element_map) {
					this.session.automationSlot = null;
					this.abortControllers.delete(taskId);
					const errorMsg = `Agent requested elementMap again after it was already provided (step ${history.length + 1})`;
					this._sendAutomationEnd(taskId, 'error', errorMsg);
					this.gemini.injectContent(`[automation context] Task "${name}" failed: ${errorMsg}`);
					logger.error('Agent needs_element_map after elementMap provided', { taskId, name, step: history.length + 1 });
					return;
				}
			}

			if (step.is_failed) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				const errorMsg = step.reasoning;
				this._sendAutomationEnd(taskId, 'error', errorMsg);
				this.gemini.injectContent(
					`[automation context] Task "${name}" could not be completed after ${history.length} step(s): ${errorMsg}`
				);
				logger.error('Automation agent declared failure', { taskId, name, step: history.length + 1, reasoning: errorMsg });
				return;
			}

			if (step.is_complete) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'complete');
				this.gemini.injectContent(
					`[automation context] Task "${name}" completed in ${history.length} step(s).`
				);
				logger.info('Automation completed', { taskId, name, steps: history.length });
				return;
			}

			if (!step.next_action) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'error', 'Agent returned no action and did not declare completion');
				this.gemini.injectContent(`[automation context] Task "${name}" failed: agent returned no action`);
				logger.error('Automation agent returned no action', { taskId, name });
				return;
			}

			const action = step.next_action;
			const result = await this._executeAction(taskId, action);

			const stepRecord: StepRecord = {
				step_number: history.length + 1,
				action_description: action.description,
				outcome: result.success ? 'succeeded' : 'failed',
				screenshot_before: dataUrlToImage(screenshotUrl),
			};
			history.push(stepRecord);

			logger.info('Action executed', {
				taskId,
				step: history.length,
				action: action.action,
				elementId: action.element_id,
				value: action.value,
				success: result.success,
				error: result.error,
			});

			if (this.session.cancelledTasks.has(taskId)) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);
				this._sendAutomationEnd(taskId, 'cancelled');
				logger.info('Automation cancelled after action', { taskId, step: history.length });
				return;
			}

			if (!result.success) {
				// Don't abort — let agent see the new state and decide
				logger.warn('Action failed, agent will decide next step', {
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
		this.gemini.injectContent(
			`[automation context] Task "${name}" aborted after ${MAX_STEPS} steps without completing`
		);
		logger.error('Automation exceeded max steps', { taskId, name, maxSteps: MAX_STEPS });
	}

	cancel(taskId: string): Record<string, unknown> {
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

		const slotIndex = this.session.researchSlots.findIndex(
			(s) => s?.taskId === taskId
		);
		if (slotIndex !== -1) {
			(this.session.researchSlots as Array<Task | null>)[slotIndex] =
				null;
		}

		logger.info('Task cancelled', { taskId });
		return { status: 'cancelled' };
	}
}
