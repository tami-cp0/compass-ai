import type { LiveServerMessage, Session } from '@google/genai';
import type { ServerMessage } from '@compass-ai/types';
import { sessionLogger, type Logger } from '../../infra/logger.js';
import { appendTurn, type ConversationHistory } from '../../infra/redis.js';
import type { TokenTracker } from '../../infra/token-tracker.js';
import { ai, LIVE_CONFIG, SYSTEM_PROMPT } from './live-config.js';

export class GeminiLiveSession {
	private sessionId: string;
	private send: (msg: ServerMessage) => void;
	private history: ConversationHistory;
	private session: Session | null = null;
	private outputTranscriptBuffer = '';
	private log: Logger;
	private tokens: TokenTracker | null = null;
	toolCallCount = 0;

	// Tool call handlers — wired by TaskManager in Phase 6
	onDispatchResearch:
		| ((name: string, description: string) => Record<string, unknown>)
		| null = null;
	onDispatchAutomation:
		| ((name: string, description: string) => Record<string, unknown>)
		| null = null;
	onCancelTask: ((name: string) => Record<string, unknown>) | null = null;
	onRequestScreenshot: (() => Promise<string>) | null = null;

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

	async connect(): Promise<void> {
		const historyContext =
			this.history.summary || this.history.recentTurns.length > 0
				? `\n\nConversation history:\n${
						this.history.summary
				  }\n${this.history.recentTurns
						.map(
							(t) =>
								`${t.role === 'user' ? 'User' : 'Compass'}: ${
									t.content
								}`
						)
						.join('\n')}`
				: '';

		this.session = await ai.live.connect({
			model: process.env.GEMINI_LIVE_MODEL!,
			config: {
				systemInstruction: SYSTEM_PROMPT + historyContext,
				...LIVE_CONFIG,
			},
			callbacks: {
				onopen: () => this.log.debug('Gemini Live connected'),
				onclose: (e) => {
					const ev = e as { code?: number; reason?: string };
					this.log.debug('Gemini Live closed', { code: ev?.code, reason: ev?.reason });
				},
				onerror: (e) =>
					this.log.error('Gemini Live error', {
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

	injectContent(text: string): void {
		if (!this.session) return;
		this.session.sendClientContent({
			turns: [{ role: 'user', parts: [{ text }] }],
			turnComplete: false,
		});
	}

	async close(): Promise<void> {
		this.session?.close();
		this.session = null;
	}

	private async handleMessage(msg: LiveServerMessage): Promise<void> {
		// Token usage — emitted on most server messages
		const um = msg.usageMetadata;
		if (um && this.tokens) {
			this.tokens.recordLive({
				inputTokens: um.promptTokenCount ?? 0,
				outputTokens: um.responseTokenCount ?? 0,
				totalTokens: um.totalTokenCount ?? 0,
				cachedTokens: um.cachedContentTokenCount,
			});
		}

		// Audio output — stream back to extension
		const audioPart = msg.serverContent?.modelTurn?.parts?.find((p) =>
			p.inlineData?.mimeType?.startsWith('audio/')
		);
		if (audioPart?.inlineData) {
			this.send({
				type: 'audio_chunk',
				sessionId: this.sessionId,
				data: audioPart.inlineData.data ?? '',
				mimeType: 'audio/pcm',
			});
		}

		// Transcript — write user speech to Redis
		const inputTranscript = msg.serverContent?.inputTranscription;
		if (inputTranscript?.text) {
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

		// Tool calls — handle synchronously, respond immediately
		const toolCall = msg.toolCall;
		if (!toolCall?.functionCalls?.length) return;

		const responses: Array<{
			id: string;
			name: string;
			response: Record<string, unknown>;
		}> = [];

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
				this.toolCallCount++;
				this.log.debug('Tool call handled', {
					tool: call.name,
					status: screenshotResult.status,
				});
				// screenshot is always the only tool in a batch — flush the
				// function response first (protocol requires it before clientContent),
				// then inject the image as a follow-up user turn
				this.session?.sendToolResponse({ functionResponses: responses });
				responses.length = 0;
				if (dataUrl) {
					const commaIdx = dataUrl.indexOf(',');
					const base64 =
						commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
					this.session?.sendClientContent({
						turns: [
							{
								role: 'user',
								parts: [
									{ text: '[page screenshot]' },
									{
										inlineData: {
											mimeType: 'image/jpeg',
											data: base64,
										},
									},
								],
							},
						],
						turnComplete: false,
					});
				}
				return;
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
				const args = call.args as Record<string, string>;

				if (
					call.name === 'dispatch_research' &&
					this.onDispatchResearch
				) {
					result = this.onDispatchResearch(
						args.name,
						args.description
					);
				} else if (
					call.name === 'dispatch_automation' &&
					this.onDispatchAutomation
				) {
					result = this.onDispatchAutomation(
						args.name,
						args.description
					);
				} else if (call.name === 'cancel_task' && this.onCancelTask) {
					result = this.onCancelTask(args.name);
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
	}
}
