import type { LiveServerMessage, Session } from '@google/genai';
import type { ServerMessage } from '@compass-ai/types';
import { sessionLogger, type Logger } from '../../infra/logger.js';
import {
	appendTurn,
	setResumptionHandle,
	type ConversationHistory,
} from '../../infra/redis.js';
import type { TokenTracker } from '../../infra/token-tracker.js';
import { ai, LIVE_CONFIG, SYSTEM_PROMPT, HELP_TOPICS } from './live-config.js';
import { nowReadableWAT } from '../../infra/datetime.js';
import { lookupSector, lookupTicker } from '../../data/ngx-equities.js';

// Backoff delays (ms) for reconnectWithHandle. Capped at 8 s after 3 doublings.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000];

export class GeminiLiveSession {
	private sessionId: string;
	private send: (msg: ServerMessage) => void;
	private history: ConversationHistory;
	private session: Session | null = null;
	private outputTranscriptBuffer = '';
	private log: Logger;
	private tokens: TokenTracker | null = null;
	private currentHandle: string | null = null;
	private reconnecting = false;
	toolCallCount = 0;

	// Inject gating. sendClientContent interrupts the model mid-utterance, so
	// background injections queue until it's idle. Kinds differ by whether they
	// provoke speech: 'result' (turnComplete:true, model announces it),
	// 'normal' (context only, stays quiet), 'heartbeat' (buffered, same-key
	// coalesced, flushed only on user speech to avoid re-announce spam).
	private isModelSpeaking = false;
	private processingToolCall = false;
	private lastUserSpeechAt = 0;
	private lastAudioChunkAt = 0;
	private userSpeechRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private gateRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private injectQueue: Array<
		| { kind: 'normal'; text: string }
		| { kind: 'result'; text: string }
		| { kind: 'heartbeat'; key: string; text: string }
	> = [];

	// Hold result flushes while the user spoke this recently — triggering a
	// model response mid-utterance would talk over them.
	private static readonly USER_SPEECH_HOLD_MS = 1500;

	// If the speaking gate is up but no audio arrived for this long, the
	// turn-end event was lost (reconnect swap, dropped frame) — force it open.
	private static readonly SPEAKING_GATE_STALE_MS = 10_000;

	// Tool call handlers — wired by TaskManager.
	onDispatchResearch:
		| ((
				name: string,
				description: string,
				profile: 'stock_analysis' | 'general_research'
		  ) => Record<string, unknown>)
		| null = null;
	onDispatchAutomation:
		| ((name: string, description: string) => Record<string, unknown>)
		| null = null;
	onCancelTask: ((name: string) => Record<string, unknown>) | null = null;
	onRequestScreenshot: (() => Promise<string>) | null = null;
	onReadPageData:
		| ((box: { x: number; y: number; width: number; height: number }) => Promise<{ data: string; truncated: boolean; error?: string } | null>)
		| null = null;
	onSetPinPane:
		| ((
				title: string,
				markdown: string,
				width: number,
				height: number,
				columns?: number,
				links?: Array<{ url: string; title: string; platform?: string }>
		  ) => Record<string, unknown>)
		| null = null;
	onClearPinPane: (() => Record<string, unknown>) | null = null;
	onMinimizePinPane: (() => Record<string, unknown>) | null = null;

	constructor(
		sessionId: string,
		send: (msg: ServerMessage) => void,
		history: ConversationHistory
	) {
		this.sessionId = sessionId;
		this.send = send;
		this.history = history;
		this.log = sessionLogger(sessionId);
	}

	async connect(opts?: { resumeHandle?: string | null }): Promise<void> {
		const resumeHandle = opts?.resumeHandle ?? null;
		this.currentHandle = resumeHandle;

		// Fresh connection, fresh gates — a turn that was mid-flight on the old
		// connection will never deliver its turnComplete here.
		this.isModelSpeaking = false;
		this.processingToolCall = false;

		// When resuming, Gemini already holds the prior context — don't inject ours.
		const historyContext = resumeHandle ? '' : this.formatHistoryContext();

		// Appended last so the static SYSTEM_PROMPT (and history) sit at the
		// cacheable prefix. Only this trailing line is volatile per session.
		const wakeContext = `\n\n<Session_Clock>\nYou came online on ${nowReadableWAT()}. Treat this as your default reference for "now" — market hours, holiday checks, freshness of cached information. It is a snapshot; if precision matters or the session has been running for a while, call request_current_time for an exact refresh. Timestamp lines on async injections ("Completed at: …", "Failed at: …") are also authoritative "now" signals.\n</Session_Clock>`;

		this.session = await ai.live.connect({
			model: process.env.GEMINI_LIVE_MODEL!,
			config: {
				systemInstruction: { parts: [{ text: SYSTEM_PROMPT + historyContext + wakeContext }] },
				...LIVE_CONFIG,
				sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
			},
			callbacks: {
				onopen: () => this.log.debug('Gemini Live connected', { resumed: resumeHandle != null }),
				onclose: (e) => {
					const ev = e as { code?: number; reason?: string };
					this.log.debug('Gemini Live closed', { code: ev?.code, reason: ev?.reason });
				},
				onerror: (e) => this.log.error('Gemini Live error', {
					error: e instanceof Error ? e : new Error(String(e)),
				}),
				onmessage: (msg: LiveServerMessage) => {
					this.handleMessage(msg).catch((err: unknown) =>
						this.log.error('handleMessage error', {
							error: err instanceof Error ? err : new Error(String(err)),
						})
					);
				},
			},
		});

		// Ground the model with the current screen from turn one so its first
		// action isn't blind. Frame first, then a caption (turnComplete:false —
		// pure context, no speech).
		if (this.onRequestScreenshot) {
			this.onRequestScreenshot()
				.then((dataUrl) => {
					if (dataUrl) {
						this.sendVideoFrame(dataUrl);
						this.session?.sendClientContent({
							turns: [{
								role: 'user',
								parts: [{ text: '[context] The image just shared is a screenshot of the page currently on the user\'s screen. This is what they are looking at right now. The user has not spoken yet — this is context only; do not respond, greet, or describe it. Wait for them to speak.' }],
							}],
							turnComplete: false,
						});
						this.log.info('[session-start] initial screenshot sent');
					}
				})
				.catch(() => {
					/* best-effort; the model can still request one itself */
				});
		}
	}

	private formatHistoryContext(): string {
		if (!this.history.summary && this.history.recentTurns.length === 0) return '';
		const turns = this.history.recentTurns
			.map((t) => `${t.role === 'user' ? 'User' : 'Compass'}: ${t.content}`)
			.join('\n');
		return `\n\nConversation history:\n${this.history.summary}\n${turns}`;
	}

	setTokenTracker(tracker: TokenTracker): void {
		this.tokens = tracker;
	}

	sendAudio(base64Pcm: string): void {
		if (!this.session) return;
		this.session.sendRealtimeInput({
			audio: { data: base64Pcm, mimeType: 'audio/pcm;rate=16000' },
		});
	}

	// Push a screenshot into the model's visual context outside the tool-call
	// flow. Used to ground automation completion announcements in the page's
	// CURRENT state (the agent's last frame may predate async data loads).
	sendVideoFrame(base64Image: string): void {
		if (!this.session) return;
		const commaIdx = base64Image.indexOf(',');
		const data = commaIdx !== -1 ? base64Image.slice(commaIdx + 1) : base64Image;
		this.session.sendRealtimeInput({
			video: { data, mimeType: 'image/png' },
		});
	}

	// Queue a background inject. Flushes when the model is idle, else waits for
	// turn/tool-call end to avoid barging in. Same-key heartbeats coalesce to
	// the latest; 'result' injects go as completed turns so the model speaks up.
	injectContent(
		text: string,
		opts?: { kind?: 'heartbeat' | 'result'; key?: string }
	): void {
		if (!this.session) return;
		if (opts?.kind === 'heartbeat' && opts.key) {
			this.injectQueue = this.injectQueue.filter(
				(q) => !(q.kind === 'heartbeat' && q.key === opts.key)
			);
			this.injectQueue.push({ kind: 'heartbeat', key: opts.key, text });
			// Heartbeats never trigger a flush — they wait for user speech.
			return;
		} else if (opts?.kind === 'result') {
			// A result supersedes any buffered progress notes: the completion
			// inject carries the full step-by-step log already.
			this.injectQueue = this.injectQueue.filter((q) => q.kind !== 'heartbeat');
			this.injectQueue.push({ kind: 'result', text });
		} else {
			this.injectQueue.push({ kind: 'normal', text });
		}
		this.flushInjectQueue();
	}

	// Drop buffered progress notes for a task (e.g. on cancel) so a stale
	// heartbeat can't surface after the task is gone.
	clearHeartbeat(key: string): void {
		this.injectQueue = this.injectQueue.filter(
			(q) => !(q.kind === 'heartbeat' && q.key === key)
		);
	}

	// On user speech: hand the model buffered progress context so its answer
	// about "what's happening" is current (turnComplete:false — pure context).
	private flushHeartbeatsForUserTurn(): void {
		if (!this.session || this.processingToolCall) return;
		const heartbeats = this.injectQueue.filter((q) => q.kind === 'heartbeat');
		if (heartbeats.length === 0) return;
		this.injectQueue = this.injectQueue.filter((q) => q.kind !== 'heartbeat');
		for (const hb of heartbeats) {
			this.session.sendClientContent({
				turns: [{ role: 'user', parts: [{ text: hb.text }] }],
				turnComplete: false,
			});
		}
	}

	private flushInjectQueue(): void {
		if (!this.session) return;
		if (
			this.isModelSpeaking &&
			Date.now() - this.lastAudioChunkAt > GeminiLiveSession.SPEAKING_GATE_STALE_MS
		) {
			this.log.warn('Speaking gate stale — forcing open', {
				sinceLastAudioMs: Date.now() - this.lastAudioChunkAt,
			});
			this.isModelSpeaking = false;
		}
		if (this.isModelSpeaking || this.processingToolCall) {
			// Blocked with deliverables queued: re-check at the staleness
			// deadline in case the turn-end event never arrives.
			if (
				this.gateRetryTimer === null &&
				this.injectQueue.some((q) => q.kind !== 'heartbeat')
			) {
				const wait = Math.max(
					500,
					GeminiLiveSession.SPEAKING_GATE_STALE_MS - (Date.now() - this.lastAudioChunkAt) + 100
				);
				this.gateRetryTimer = setTimeout(() => {
					this.gateRetryTimer = null;
					this.flushInjectQueue();
				}, wait);
			}
			return;
		}

		// If the user spoke moments ago they may still be mid-thought; a
		// result flush would trigger a response that talks over them. Retry
		// shortly — turnComplete/interrupted events also re-drain the queue.
		const sinceUserSpeech = Date.now() - this.lastUserSpeechAt;
		if (
			sinceUserSpeech < GeminiLiveSession.USER_SPEECH_HOLD_MS &&
			this.injectQueue.some((q) => q.kind === 'result')
		) {
			if (this.userSpeechRetryTimer === null) {
				this.userSpeechRetryTimer = setTimeout(() => {
					this.userSpeechRetryTimer = null;
					this.flushInjectQueue();
				}, GeminiLiveSession.USER_SPEECH_HOLD_MS - sinceUserSpeech + 50);
			}
			return;
		}

		// Heartbeats are excluded from proactive flushing — they leave the
		// queue only via flushHeartbeatsForUserTurn (or supersession).
		while (this.injectQueue.some((q) => q.kind !== 'heartbeat')) {
			const idx = this.injectQueue.findIndex((q) => q.kind !== 'heartbeat');
			const item = this.injectQueue.splice(idx, 1)[0];
			const isResult = item.kind === 'result';
			this.session.sendClientContent({
				turns: [{ role: 'user', parts: [{ text: item.text }] }],
				turnComplete: isResult,
			});
			// A result flush starts a model response — stop draining so we
			// don't interleave content with the incoming turn. The rest of
			// the queue flushes on the next turnComplete.
			if (isResult) {
				this.isModelSpeaking = true;
				break;
			}
		}
	}

	async close(): Promise<void> {
		if (this.userSpeechRetryTimer !== null) {
			clearTimeout(this.userSpeechRetryTimer);
			this.userSpeechRetryTimer = null;
		}
		if (this.gateRetryTimer !== null) {
			clearTimeout(this.gateRetryTimer);
			this.gateRetryTimer = null;
		}
		this.session?.close();
		this.session = null;
	}

	private async reconnectWithHandle(): Promise<void> {
		if (this.reconnecting || !this.currentHandle) return;
		this.reconnecting = true;
		const oldSession = this.session;
		this.session = null;
		let lastErr: unknown;
		try {
			for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
				if (attempt > 0) {
					const delay = RECONNECT_DELAYS_MS[attempt - 1];
					this.log.debug('Gemini Live reconnect retrying', { attempt, delayMs: delay });
					await new Promise<void>((r) => setTimeout(r, delay));
				}
				try {
					await this.connect({ resumeHandle: this.currentHandle });
					this.log.info('Gemini Live reconnected', { attempt });
					oldSession?.close();
					return;
				} catch (err) {
					lastErr = err;
				}
			}
			// All attempts exhausted
			this.log.error('Gemini Live reconnect exhausted', {
				error: lastErr instanceof Error ? lastErr : new Error(String(lastErr)),
			});
			oldSession?.close();
		} finally {
			this.reconnecting = false;
		}
	}

	private async handleMessage(msg: LiveServerMessage): Promise<void> {
		const resumption = msg.sessionResumptionUpdate;
		if (resumption?.resumable && resumption.newHandle) {
			this.currentHandle = resumption.newHandle;
			setResumptionHandle(this.sessionId, resumption.newHandle).catch(
				(err: unknown) =>
					this.log.error('Redis setResumptionHandle failed', {
						error: err instanceof Error ? err : new Error(String(err)),
					})
			);
		}

		// goAway = the 10-min cap is approaching. Swap the Gemini connection
		// transparently; the extension sees no interruption.
		if (msg.goAway) {
			void this.reconnectWithHandle();
			return;
		}

		// Token usage — emitted on most server messages
		const um = msg.usageMetadata;
		if (um && this.tokens) {
			this.tokens.recordLive(
				{
					inputTokens: um.promptTokenCount ?? 0,
					outputTokens: um.responseTokenCount ?? 0,
					totalTokens: um.totalTokenCount ?? 0,
					cachedTokens: um.cachedContentTokenCount,
				},
				{
					input: um.promptTokensDetails,
					output: um.responseTokensDetails,
				}
			);
		}

		// Audio output — stream back to extension. Parts flagged `thought` are
		// the model's reasoning channel (native-audio "thinking aloud", spoken
		// in a different default voice) — never forward those to the user.
		const audioPart = msg.serverContent?.modelTurn?.parts?.find(
			(p) => p.inlineData?.mimeType?.startsWith('audio/') && !p.thought
		);
		if (audioPart?.inlineData) {
			// First audio chunk of a turn opens the speaking gate; queued
			// injects wait for turnComplete / interrupted.
			this.isModelSpeaking = true;
			this.lastAudioChunkAt = Date.now();
			this.send({
				type: 'audio_chunk',
				sessionId: this.sessionId,
				data: audioPart.inlineData.data ?? '',
				mimeType: 'audio/pcm',
			});
		}

		// Transcript — write user speech to Redis. Also feeds the inject
		// gate: a fresh transcript fragment means the user is (or was just)
		// talking, so result flushes hold off briefly.
		const inputTranscript = msg.serverContent?.inputTranscription;
		if (inputTranscript?.text) {
			this.lastUserSpeechAt = Date.now();
			this.flushHeartbeatsForUserTurn();
			appendTurn(this.sessionId, {
				role: 'user',
				content: inputTranscript.text,
			}).catch((err: unknown) =>
				this.log.error('Redis appendTurn failed', {
					turn: 'user',
					error: err instanceof Error ? err : new Error(String(err)),
				})
			);
		}

		// Buffer incremental output transcription
		const outputTranscript = msg.serverContent?.outputTranscription;
		if (outputTranscript?.text) {
			this.outputTranscriptBuffer += outputTranscript.text;
		}

		// Flush buffered transcript to Redis on turn complete
		if (msg.serverContent?.turnComplete && this.outputTranscriptBuffer) {
			const text = this.outputTranscriptBuffer;
			this.outputTranscriptBuffer = '';
			appendTurn(this.sessionId, { role: 'model', content: text }).catch(
				(err: unknown) =>
					this.log.error('Redis appendTurn failed', {
						turn: 'model',
						error: err instanceof Error ? err : new Error(String(err)),
					})
			);
		}

		// Close the speaking gate on natural turn end or user-driven interrupt,
		// then flush any background injects that piled up while the model was
		// speaking.
		if (msg.serverContent?.turnComplete || msg.serverContent?.interrupted) {
			this.isModelSpeaking = false;
			this.flushInjectQueue();
		}

		// Tool calls — handle synchronously, respond immediately
		const toolCall = msg.toolCall;
		if (!toolCall?.functionCalls?.length) return;

		// Hold injects until this tool-call batch and its follow-up media frame
		// have been sent, so a background task that completes mid-handler can't
		// interleave clientContent with the required functionResponses/realtimeInput.
		this.processingToolCall = true;

		const responses: Array<{
			id: string;
			name: string;
			response: Record<string, unknown>;
		}> = [];

		// Captured screenshot payload — sent as a realtimeInput frame AFTER the
		// batched toolResponse (protocol requires functionResponses before any
		// clientContent/realtimeInput follow-up).
		let screenshotImageBase64: string | null = null;

		for (const call of toolCall.functionCalls) {
			let result: Record<string, unknown>;

			// Handle no-args tools first, before the args guard
			if (
				call.name === 'request_screenshot' &&
				this.onRequestScreenshot
			) {
				const dataUrl = await this.onRequestScreenshot();
				const screenshotResult: Record<string, unknown> = dataUrl
					? { status: 'captured' }
					: { status: 'failed', reason: 'capture_error' };
				responses.push({
					id: call.id ?? '',
					name: call.name ?? '',
					response: screenshotResult,
				});
				if (dataUrl) {
					const commaIdx = dataUrl.indexOf(',');
					screenshotImageBase64 =
						commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
				}
				this.toolCallCount++;
				this.log.info('[request_screenshot] captured', {
					status: screenshotResult.status,
				});
				// Continue processing any remaining tools in this batch — the
				// screenshot image frame is sent after the full toolResponse below.
				continue;
			} else if (call.name === 'read_page_data' && this.onReadPageData) {
				const a = (call.args ?? {}) as Record<string, unknown>;
				const box = {
					x: Number(a.x),
					y: Number(a.y),
					width: Number(a.width),
					height: Number(a.height),
				};
				const validBox =
					[box.x, box.y, box.width, box.height].every(Number.isFinite) &&
					box.width > 0 &&
					box.height > 0;
				if (!validBox) {
					result = { status: 'failed', reason: 'invalid_box' };
				} else {
					const pageData = await this.onReadPageData(box);
					result =
						pageData === null
							? { status: 'failed', reason: 'extraction_timeout_or_no_tab' }
							: pageData.error
								? { status: 'failed', reason: pageData.error }
								: { status: 'ok', data: pageData.data };
					this.log.info('[read-page-data] extraction', {
						box,
						status: result.status,
						chars: pageData?.data.length ?? 0,
						text: pageData?.data ?? '',
					});
				}
			} else if (call.name === 'clear_pin_pane' && this.onClearPinPane) {
				result = this.onClearPinPane();
			} else if (call.name === 'minimize_pin_pane' && this.onMinimizePinPane) {
				result = this.onMinimizePinPane();
			} else if (call.name === 'get_tool_help') {
				const names = ((call.args as Record<string, unknown> | undefined)?.names ?? []) as unknown[];
				const topics = (Array.isArray(names) ? names : [])
					.map((n) => String(n))
					.map((n) => ({ name: n, help: HELP_TOPICS[n] ?? null }));
				const unknown = topics.filter((t) => t.help === null).map((t) => t.name);
				result = {
					status: 'ok',
					topics: topics.filter((t) => t.help !== null),
					...(unknown.length ? { unknown_topics: unknown, available: Object.keys(HELP_TOPICS) } : {}),
				};
				this.log.info('[get_tool_help] loaded', {
					requested: topics.map((t) => t.name),
					unknown,
				});
			} else if (call.name === 'request_current_time') {
				result = { time: nowReadableWAT() };
			} else {
				// All other tools require args
				if (!call.args) {
					responses.push({
						id: call.id ?? '',
						name: call.name ?? '',
						response: { error: 'missing args' },
					});
					continue;
				}
				const args = call.args as Record<string, unknown>;

				if (
					call.name === 'dispatch_research' &&
					this.onDispatchResearch
				) {
					result = this.onDispatchResearch(
						args.name as string,
						args.description as string,
						args.profile as 'stock_analysis' | 'general_research'
					);
				} else if (
					call.name === 'dispatch_automation' &&
					this.onDispatchAutomation
				) {
					result = this.onDispatchAutomation(
						args.name as string,
						args.description as string
					);
				} else if (call.name === 'cancel_task' && this.onCancelTask) {
					result = this.onCancelTask(args.name as string);
				} else if (call.name === 'lookup_ticker') {
					result = args.by_sector === true
						? { ...lookupSector(args.query as string) }
						: { ...lookupTicker(args.query as string) };
				} else if (call.name === 'set_pin_pane' && this.onSetPinPane) {
					result = this.onSetPinPane(
						args.title as string,
						args.markdown as string,
						Number(args.width),
						Number(args.height),
						args.columns !== undefined ? Number(args.columns) : undefined,
						Array.isArray(args.links)
							? (args.links as Array<{ url: string; title: string; platform?: string }>)
							: undefined
					);
				} else {
					result = {
						status: 'acknowledged',
						note: 'Tool handler not yet wired',
					};
				}
			}

			responses.push({
				id: call.id ?? '',
				name: call.name ?? '',
				response: result,
			});
			this.toolCallCount++;
			this.log.debug('Tool call handled', {
				tool: call.name,
				status: result.status,
			});
		}

		this.session?.sendToolResponse({ functionResponses: responses });

		// Send the screenshot image as a follow-up media frame — AFTER the batched
		// toolResponse (protocol requires functionResponses before realtimeInput).
		if (screenshotImageBase64 !== null) {
			this.session?.sendRealtimeInput({
				video: { data: screenshotImageBase64, mimeType: 'image/jpeg' },
			});
		}

		// Release the tool-call gate and drain any injects that piled up while
		// the handler was awaiting the screenshot capture.
		this.processingToolCall = false;
		this.flushInjectQueue();
	}
}
