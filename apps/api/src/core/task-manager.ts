import { v4 as uuidv4 } from 'uuid';
import type {
	AgentAction,
	Box,
	ExtensionMessage,
	SessionState,
	Task,
} from '@compass-ai/types';
import type { GeminiLiveSession } from '../agents/conversation/gemini-live-session.js';
import { HELP_TOPICS } from '../agents/conversation/live-config.js';
import { runResearchAgent, runQuickSearch } from '../agents/research/research-agent.js';
import { runWebAgentStep, type WebObservation } from '../agents/web/web-step.js';
import { scaleAction } from '../agents/web/web-tools.js';
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
	// The first research completion pre-injects the pane composition guide as
	// silent context, so the model can pin a rich result immediately instead of
	// paying a get_tool_help round trip first. Once per session; get_tool_help
	// remains the fallback if compression later evicts it.
	private paneGuideInjected = false;
	private pendingObservations = new Map<
		string,
		(msg: Extract<ExtensionMessage, { type: 'agent_observation' }> | null) => void
	>();
	private pendingActionResults = new Map<
		string,
		(msg: Extract<ExtensionMessage, { type: 'agent_action_result' }> | null) => void
	>();
	private pendingScreenshots = new Map<string, (dataUrl: string) => void>();
	private pendingPageData = new Map<
		string,
		(msg: Extract<ExtensionMessage, { type: 'page_data_response' }> | null) => void
	>();

	constructor(session: SessionState, gemini: GeminiLiveSession) {
		this.session = session;
		this.gemini = gemini;
		this.log = sessionLogger(session.sessionId);
		this.tokens = new TokenTracker(session.sessionId);
		gemini.setTokenTracker(this.tokens);
		gemini.onRequestScreenshot = () => this._requestScreenshot();
		// Live agent frames are physical-resolution → physicalPixels: true.
		gemini.onReadPageData = (box) => this._requestPageData(box, true);
		gemini.onVisionChange = (on) => {
			this.session.send({
				type: on ? 'vision_start' : 'vision_stop',
				sessionId: this.session.sessionId,
			});
		};
		gemini.getPendingTaskNames = () => this.pendingTaskNames();
	}

	// Names of tasks still running, so the model can be told — as bare fact, not
	// instruction — what it's still waiting on when it takes a turn. Empty when
	// nothing is in flight.
	pendingTaskNames(): string[] {
		const names = this.session.researchSlots
			.filter((s): s is Task => s !== null)
			.map((s) => `research "${s.name}"`);
		if (this.session.automationSlot) {
			names.push(`automation "${this.session.automationSlot.name}"`);
		}
		return names;
	}

	// A vision frame arrived from the extension — push it into the model's
	// visual context as a realtime video frame.
	handleVisionFrame(msg: Extract<ExtensionMessage, { type: 'vision_frame' }>): void {
		if (msg.data) {
			this.gemini.sendVideoFrame(msg.data);
			this.tokens.recordVisionFrame();
		}
	}

	private _sendResearchStatus(
		taskId: string,
		name: string,
		status: 'started' | 'completed' | 'failed' | 'cancelled'
	): void {
		this.session.send({
			type: 'research_status',
			sessionId: this.session.sessionId,
			taskId,
			name,
			status,
		});
	}

	dispatchResearch(name: string, description: string): Record<string, unknown> {
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
		this.log.info('Research dispatched', { taskId, name });
		this._sendResearchStatus(taskId, name, 'started');

		this._runResearch(task, slotIndex, controller.signal);

		return {
			taskId,
			status: 'dispatched',
			free_research_slots_remaining:
				this.session.researchSlots.filter((s) => s === null).length - 1,
		};
	}

	// A quick_search runs inline (not through a research slot): it's fast and
	// cheap, and the live agent awaits the answer rather than being pinged later.
	// One at a time — it can run alongside the (single) deep research. It drives
	// the same pill chip as research so the user sees the lookup happening.
	private quickSearchRunning = false;

	async quickSearch(query: string): Promise<Record<string, unknown>> {
		if (this.quickSearchRunning) {
			return { status: 'rejected', reason: 'quick_search_already_running' };
		}
		this.quickSearchRunning = true;
		const taskId = uuidv4();
		const name = `quick: ${query.slice(0, 60)}`;
		this.log.info('Quick search dispatched', { taskId, query: query.slice(0, 120) });
		this._sendResearchStatus(taskId, name, 'started');
		try {
			const { answer, usage } = await runQuickSearch(query);
			this.tokens.recordResearch(taskId, 'quick_search', usage, 'quick');
			this._sendResearchStatus(taskId, name, 'completed');
			this.log.info('Quick search completed', { taskId });
			return { status: 'ok', answer };
		} catch (err: unknown) {
			const error = err instanceof Error ? err : new Error(String(err));
			this._sendResearchStatus(taskId, name, 'failed');
			this.log.error('Quick search failed', { taskId, error });
			return { status: 'error', error: error.message };
		} finally {
			this.quickSearchRunning = false;
		}
	}

	private _runResearch(task: Task, slotIndex: number, signal: AbortSignal): void {
		const { taskId, name, description } = task;

		runResearchAgent(description, signal)
			.then(({ result, usage }) => {
				if (this.session.cancelledTasks.has(taskId)) {
					this.log.debug('Research result discarded — task was cancelled', { taskId });
					return;
				}
				(this.session.researchSlots as Array<Task | null>)[slotIndex] = null;
				this.abortControllers.delete(taskId);
				this.tokens.recordResearch(taskId, name, usage, 'deep');
				const body = JSON.stringify(result);
				const MAX = 10_000;
				const trimmed = body.length > MAX ? body.slice(0, MAX) + '\n[...truncated]' : body;
				// Pre-inject the pane guide (silent context) ahead of the first
				// result, so composing a rich pane needs no get_tool_help turn.
				if (!this.paneGuideInjected) {
					this.paneGuideInjected = true;
					this.gemini.injectContent(
						`[context] Pane composition guide — pre-loaded so you can pin rich results without fetching it. This is the same content as get_tool_help(["set_pin_pane"]); do not fetch it again.\n\n${HELP_TOPICS.set_pin_pane}`
					);
				}
				const payload = `[research_result: ${name}]\nCompleted at: ${nowReadableWAT()}\n${trimmed}`;
				this.gemini.injectContent(payload, { kind: 'result' });
				this._sendResearchStatus(taskId, name, 'completed');
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
					`[research error] Task "${name}" failed: ${error.message}\nFailed at: ${nowReadableWAT()}`,
					{ kind: 'result' }
				);
				this._sendResearchStatus(taskId, name, 'failed');
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

		// Minimize the pane to its puck before the web agent captures the page,
		// so the pane never covers content in the agent's screenshot. Content is
		// kept (not cleared) — the user re-opens it by tapping the puck.
		this.session.send({ type: 'pin_pane_minimize', sessionId: this.session.sessionId });

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

	handlePageDataResponse(
		msg: Extract<ExtensionMessage, { type: 'page_data_response' }>
	): void {
		const resolve = this.pendingPageData.get(msg.requestId);
		if (resolve) {
			this.pendingPageData.delete(msg.requestId);
			resolve(msg);
		}
	}

	// physicalPixels flags whether the box is in physical-resolution screenshot
	// pixels (the live agent's frame → extension divides by dpr) or CSS pixels
	// (the web agent's frame → used as-is).
	private _requestPageData(
		box: Box,
		physicalPixels: boolean
	): Promise<Extract<ExtensionMessage, { type: 'page_data_response' }> | null> {
		const requestId = uuidv4();
		this.session.send({
			type: 'page_data_request',
			sessionId: this.session.sessionId,
			requestId,
			box,
			physicalPixels,
		});

		return new Promise((resolve) => {
			this.pendingPageData.set(requestId, resolve);

			setTimeout(() => {
				if (this.pendingPageData.has(requestId)) {
					this.pendingPageData.delete(requestId);
					resolve(null);
				}
			}, 10_000);
		});
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
	): Promise<{ success: boolean; error?: string; data?: string }> {
		// page:read is not a CDP input — it goes through the box-extraction path.
		// Web-agent screenshots are CSS pixels, so physicalPixels: false.
		if (action.variant === 'page:read') {
			const resp = await this._requestPageData(
				{ x: action.x, y: action.y, width: action.width, height: action.height },
				false
			);
			if (!resp) return { success: false, error: 'page read timed out' };
			if (resp.error) return { success: false, error: resp.error };
			return { success: true, data: resp.data };
		}

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
				`[automation context] Task "${name}" failed: ${error.message}\nFailed at: ${nowReadableWAT()}\nGoal: ${description}${logSegment}\nautomation_slot_freed: true`,
				{ kind: 'result' }
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

		// Results of the previous turn's actions, fed back as tool_results on the
		// next observation. Undefined on the first turn.
		let lastActionResults: WebObservation['actionResults'];

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
				cssWidth: obsMsg.cssWidth,
				cssHeight: obsMsg.cssHeight,
				url: obsMsg.url,
				title: obsMsg.title,
				scrollRegions: obsMsg.scrollRegions,
				actionResults: lastActionResults,
			};

			const { step, usage } = await runWebAgentStep(memory, observation);
			this.tokens.recordAutomationStep(taskId, name, memory.stepCount + 1, usage);

			if (this._isCancelled(taskId, task, 'after agent step', memory.stepCount)) return;

			// The model's coords are in image space; CDP dispatch and DOM reads
			// need CSS pixels. Scale every action down by cssWidth/imageWidth
			// (a no-op on dpr-1 displays where image == CSS size).
			const coordScale = obsMsg.width > 0 ? obsMsg.cssWidth / obsMsg.width : 1;
			if (coordScale !== 1) {
				step.actions = step.actions.map((a) => scaleAction(a, coordScale));
			}

			// Execute this turn's actions. EVERY tool_use id must get exactly one
			// tool_result next turn or the API rejects the message, so we emit a
			// result for each — real for executed actions, a "skipped" note for
			// any dropped after an earlier failure ended the batch.
			lastActionResults = [];
			let batchFailed = false;
			for (let i = 0; i < step.actions.length; i++) {
				const action = step.actions[i];
				const toolUseId = step.toolUseIds[i];

				if (batchFailed) {
					lastActionResults.push({ toolUseId, ok: false, error: 'skipped — a prior action in this batch failed' });
					continue;
				}

				const result = await this._executeAction(taskId, action);
				lastActionResults.push({
					toolUseId,
					ok: result.success,
					...(result.error ? { error: result.error } : {}),
					...(result.data !== undefined ? { text: result.data } : {}),
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

				if (!result.success) batchFailed = true; // stop executing; still record the rest as skipped
			}

			// Answer any tool_use that produced no browser action (e.g. a bare
			// screenshot request). Without a result the API rejects the next turn.
			// The fresh screenshot rides in the observation the loop sends anyway.
			for (const toolUseId of step.noopToolUseIds) {
				lastActionResults.push({ toolUseId, ok: true, text: 'Screenshot follows.' });
			}

			memory.recordTurn(step.reasoning, step.actions);

			// Hard stop for no-progress loops: WebAgentMemory warns at 2 repeated
			// dead pointer actions; a 3rd means the run is going nowhere. A
			// terminal this turn takes precedence — the agent is ending anyway.
			if (!step.terminal && memory.noProgressStreak >= 3) {
				this._failAutomation(
					task,
					memory,
					'Stuck: 3 consecutive pointer actions produced no change',
					'no_progress_loop',
					memory.stepCount
				);
				return;
			}

			if (step.terminal) {
				this.session.automationSlot = null;
				this.abortControllers.delete(taskId);

				const progressLog = memory.renderProgressLog();

				// End the run. We deliberately do NOT push a screenshot to the live
				// agent here — a handed frame is a secondhand crutch it would
				// describe instead of looking. If the user needs the current screen,
				// the live agent enables its own vision (see <Async_Returns>).
				this._sendAutomationEnd(
					taskId,
					step.terminal.kind === 'done' ? 'complete' : 'error',
					step.terminal.kind === 'fail' ? step.terminal.reason : undefined
				);

				if (step.terminal.kind === 'done') {
					// Mechanical outcome only — the web agent's own description of what
					// it saw is deliberately NOT forwarded. "It ran" is not "here's
					// what's on screen"; if the user needs the current state, the live
					// agent must confirm with its own vision (see <Async_Returns>).
					this.gemini.injectContent(
						`[automation context] Task "${name}" finished its run in ${memory.stepCount} step(s).\nCompleted at: ${nowReadableWAT()}\nGoal: ${description}\n${progressLog}\nThe run reached its end; whatever is on the user's screen now is the result. This is a mechanical outcome, not a description of the screen — if the user needs to know what's showing, look with your own vision.\nautomation_slot_freed: true`,
						{ kind: 'result' }
					);
					this.metrics.automationCompleted++;
					this.log.info('Automation completed', {
						taskId,
						name,
						steps: memory.stepCount,
						durationMs: Date.now() - task.startedAt,
					});
				} else {
					this.gemini.injectContent(
						`[automation context] Task "${name}" could not be completed after ${memory.stepCount} step(s): ${step.terminal.reason}\nFailed at: ${nowReadableWAT()}\nGoal: ${description}\n${progressLog}\nautomation_slot_freed: true`,
						{ kind: 'result' }
					);
					this.metrics.automationFailed++;
					this.log.error('Automation failed', {
						taskId,
						name,
						reason: 'agent_declared_failure',
						step: memory.stepCount,
						declaredReason: step.terminal.reason,
						durationMs: Date.now() - task.startedAt,
					});
				}
				return;
			}

			// Mid-run heartbeat every 2 steps: silent context, tagged so
			// successive ticks coalesce in the inject queue (only the latest
			// flushes if the model was speaking through several steps).
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
			`[automation context] Task "${name}" failed: ${errorMsg}\nFailed at: ${nowReadableWAT()}\nGoal: ${description}${logSegment}\nautomation_slot_freed: true`,
			{ kind: 'result' }
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
		this.gemini.clearHeartbeat(`automation:${taskId}`);
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

	// Cancel running task(s). With a name, cancels that specific task. Without,
	// cancels by scope ('all' by default) — every running research task and/or
	// the automation. Name-optional so the live agent can always stop work even
	// if it doesn't recall the exact dispatch name.
	cancel(name?: string, scope: 'all' | 'research' | 'automation' = 'all'): Record<string, unknown> {
		const running: Task[] = [
			...this.session.researchSlots.filter((s): s is Task => s !== null),
			...(this.session.automationSlot ? [this.session.automationSlot] : []),
		];

		let targets: Task[];
		if (name) {
			targets = running.filter((t) => t.name === name);
			if (targets.length === 0) {
				return { status: 'not_found', reason: 'no_running_task_with_that_name' };
			}
		} else {
			targets = running.filter(
				(t) => scope === 'all' || t.type === scope
			);
			if (targets.length === 0) {
				return { status: 'nothing_to_cancel', scope };
			}
		}

		const cancelled = targets.map((t) => this._cancelTask(t));
		return { status: 'cancelled', cancelled };
	}

	// Tear down one running task: mark cancelled, abort its request/loop, and
	// resolve any promises it's blocked on so it unwinds promptly.
	private _cancelTask(task: Task): string {
		const { taskId, name } = task;
		this.session.cancelledTasks.add(taskId);
		this.abortControllers.get(taskId)?.abort();
		this.abortControllers.delete(taskId);

		const observationResolve = this.pendingObservations.get(taskId);
		if (observationResolve) {
			this.pendingObservations.delete(taskId);
			observationResolve(null);
		}

		if (task.type === 'automation') {
			for (const [actionId, resolve] of this.pendingActionResults) {
				resolve(null);
				this.pendingActionResults.delete(actionId);
			}
			for (const [requestId, resolve] of this.pendingScreenshots) {
				resolve('');
				this.pendingScreenshots.delete(requestId);
			}
		} else {
			const slotIndex = this.session.researchSlots.findIndex((s) => s?.taskId === taskId);
			if (slotIndex !== -1) {
				(this.session.researchSlots as Array<Task | null>)[slotIndex] = null;
			}
			this._sendResearchStatus(taskId, name, 'cancelled');
		}

		this.log.info('Task cancelled', { taskId, name, type: task.type });
		return name;
	}
}
