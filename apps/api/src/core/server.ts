import { App, DISABLED, type us_listen_socket } from 'uWebSockets.js';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { ExtensionMessage, ServerMessage, SessionKeys } from '@compass-ai/types';
import { createSession, deleteSession, sessionCount } from './session-store.js';
import { logger, sessionLogger } from '../infra/logger.js';
import { GeminiLiveSession } from '../agents/conversation/gemini-live-session.js';
import {
	clearSessionHistory,
	getConversationHistory,
	getResumptionHandle,
} from '../infra/session-history.js';
import { TaskManager } from './task-manager.js';
import { unwrapOuterFence } from './pane-estimate.js';
import { classifyProviderError } from '../infra/provider-errors.js';
import { recordEmail } from '../infra/email-store.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/api/src/core → apps/api/logs (same convention as web-step.ts)
const PANE_LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');

if (!process.env.PORT) {
	throw new Error('PORT environment variable is not set');
}
if (!process.env.NODE_ENV) {
	throw new Error('NODE_ENV environment variable is not set');
}

const IS_DEV = process.env.NODE_ENV === 'development';

if (!IS_DEV && !process.env.ALLOWED_ORIGINS) {
	throw new Error('ALLOWED_ORIGINS environment variable is required when NODE_ENV is not development');
}

const PORT = Number(process.env.PORT);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
	.split(',')
	.map((o) => o.trim())
	.filter(Boolean);

interface ApiSession {
	sessionId: string;
	gemini: GeminiLiveSession;
	taskManager: TaskManager;
	startedAt: number;
}

// Validate the user-provided keys that arrived on session_start/resume. Gemini
// is always required; Claude is required only when web automation is on. Returns
// the built per-session clients, or an error reason to reject the session with.
function buildSessionClients(
	keys: SessionKeys | undefined,
	webAutomation: boolean
):
	| { ok: true; geminiClient: GoogleGenAI; claudeClient: Anthropic | null }
	| { ok: false; reason: string; provider: 'gemini' | 'claude' } {
	const geminiKey = keys?.gemini?.trim();
	if (!geminiKey) {
		return {
			ok: false,
			provider: 'gemini',
			reason: 'A Gemini API key is required to start a session.',
		};
	}
	let claudeClient: Anthropic | null = null;
	if (webAutomation) {
		const claudeKey = keys?.claude?.trim();
		if (!claudeKey) {
			return {
				ok: false,
				provider: 'claude',
				reason: 'A Claude API key is required when web automation is enabled.',
			};
		}
		claudeClient = new Anthropic({ apiKey: claudeKey });
	}
	return { ok: true, geminiClient: new GoogleGenAI({ apiKey: geminiKey }), claudeClient };
}

const apiSessions = new Map<string, ApiSession>();

function emitSessionSummary(sessionId: string, apiSession: ApiSession, closeCode?: number, closeReason?: string): void {
	const log = sessionLogger(sessionId);
	const m = apiSession.taskManager.metrics;
	const t = apiSession.taskManager.tokens.summary();
	log.info('Session summary', {
		durationMs: Date.now() - apiSession.startedAt,
		toolCalls: apiSession.gemini.toolCallCount,
		researchDispatched: m.researchDispatched,
		researchCompleted: m.researchCompleted,
		researchFailed: m.researchFailed,
		automationDispatched: m.automationDispatched,
		automationCompleted: m.automationCompleted,
		automationFailed: m.automationFailed,
		automationSteps: m.automationSteps,
		// Token rollup (dev only; zeros in prod). Single research path now;
		// automation/live show cache savings, vision shows usage.
		tokens: {
			research: { count: t.research.count, total: t.research.totalTokens },
			automation: { runs: t.automation.runs, steps: t.automation.steps, total: t.automation.totalTokens, cached: t.automation.cachedInputTokens },
			live: { calls: t.live.calls, total: t.live.totalTokens, cached: t.live.cachedInputTokens, frames: t.live.frameTokens },
			vision: { timesEnabled: t.vision.enableCount, byMode: t.vision.byMode, framesSent: t.vision.framesSent },
		},
		...(closeCode !== undefined ? { closeCode, closeReason } : {}),
	});
}

/**
 * Closes all active Gemini sessions in parallel (Promise.allSettled so one
 * stuck close doesn't block the others), emits a summary log for each, then
 * clears the map. Called by the process-level shutdown handler in index.ts.
 */
export async function shutdownAllSessions(): Promise<void> {
	const entries = [...apiSessions.entries()];
	await Promise.allSettled(
		entries.map(async ([sessionId, apiSession]) => {
			emitSessionSummary(sessionId, apiSession);
			await apiSession.gemini.close();
		})
	);
	apiSessions.clear();
}

export function startServer(): us_listen_socket | false {
	const app = App();

	app.ws<{ sessionId: string | null; closed: boolean }>('/ws', {
		compression: DISABLED,
		maxPayloadLength: 16 * 1024 * 1024,
		idleTimeout: 120,

		upgrade(res, req, context) {
			const origin = req.getHeader('origin');
			if (!IS_DEV && !ALLOWED_ORIGINS.includes(origin)) {
				logger.warn('WS upgrade rejected', { origin });
				res.writeStatus('403 Forbidden').end();
				return;
			}
			res.upgrade(
				{ sessionId: null, closed: false },
				req.getHeader('sec-websocket-key'),
				req.getHeader('sec-websocket-protocol'),
				req.getHeader('sec-websocket-extensions'),
				context
			);
		},

		open() {
			logger.debug('WS connection opened');
		},

		async message(ws, rawMessage) {
			let msg: ExtensionMessage;
			try {
				msg = JSON.parse(
					Buffer.from(rawMessage).toString('utf8')
				) as ExtensionMessage;
			} catch {
				logger.warn('Unparseable message');
				return;
			}

			// The task manager and async tool returns hold this closure beyond the
			// socket's lifetime; uWS hard-throws on send-after-close (e.g. a page
			// refresh mid-automation), which took the whole process down. Guard it.
			const userData = ws.getUserData();
			const send = (m: ServerMessage) => {
				if (userData.closed) return;
				try {
					ws.send(JSON.stringify(m));
				} catch {
					userData.closed = true;
				}
			};

			if (msg.type === 'session_start' || msg.type === 'session_resume') {
				// Build the per-session LLM clients from the user's keys before
				// touching any session state. Reject early on missing/invalid keys.
				const built = buildSessionClients(msg.keys, msg.webAutomation);
				if (!built.ok) {
					logger.warn('Session rejected — missing key', { reason: built.reason });
					send({
						type: 'session_error',
						reason: built.reason,
						kind: 'missing_key',
						provider: built.provider,
					});
					return;
				}
				const { geminiClient, claudeClient } = built;

				// Record the user's email (the only identity we keep — never keys).
				// Best-effort: a store failure must not block the session.
				recordEmail(msg.email ?? '').catch((err: unknown) =>
					logger.warn('recordEmail failed', {
						error: err instanceof Error ? err.message : String(err),
					})
				);

				const existing = ws.getUserData().sessionId;
				if (existing) {
					const prev = apiSessions.get(existing);
					if (prev) {
						emitSessionSummary(existing, prev);
						await prev.gemini.close();
						apiSessions.delete(existing);
					}
					deleteSession(existing);
					logger.debug('Previous session torn down for re-start', { sessionId: existing });
				}

				// Reuse the requested sessionId only if Gemini still has its context
				// (i.e. the handle is still in the in-memory store). Otherwise we
				// start clean with a new id.
				const resumeHandle =
					msg.type === 'session_resume'
						? await getResumptionHandle(msg.sessionId)
						: null;
				const sessionId =
					resumeHandle && msg.type === 'session_resume' ? msg.sessionId : uuidv4();
				ws.getUserData().sessionId = sessionId;

				const history = await getConversationHistory(sessionId);
				const session = createSession(sessionId, send);
				const gemini = new GeminiLiveSession(sessionId, send, history, geminiClient, msg.voiceName);
				const taskManager = new TaskManager(session, gemini, geminiClient, claudeClient);
				apiSessions.set(sessionId, { sessionId, gemini, taskManager, startedAt: Date.now() });

				gemini.onDispatchResearch = (name, desc) =>
					taskManager.dispatchResearch(name, desc);
				gemini.onDispatchAutomation = (name, desc) =>
					taskManager.dispatchAutomation(name, desc);
				gemini.onCancelTask = (name, scope) => taskManager.cancel(name, scope);
				gemini.onSetPinPane = (title, rawMarkdown, width, height, columns, links) => {
					// Server clamps only to absolute sanity limits. The extension
					// further clamps width at render time to fit between the pill
					// and the viewport edge.
					const requestedWidth = Math.max(220, Math.round(width));
					const appliedHeight = Math.max(120, Math.min(1040, Math.round(height)));
					// 1 (default) or 2 columns. Two columns roughly halve the
					// rendered height, so the fit check uses estimate / columns.
					const appliedColumns = columns === 2 ? 2 : 1;
					// Link louvers: http(s) only, url+title required, max 3.
					const appliedLinks = (links ?? [])
						.filter(
							(l) =>
								l &&
								typeof l.url === 'string' &&
								/^https?:\/\//i.test(l.url) &&
								typeof l.title === 'string' &&
								l.title.trim() !== ''
						)
						.slice(0, 3)
						.map((l) => ({
							url: l.url,
							title: l.title.trim(),
							...(typeof l.platform === 'string' && l.platform.trim() !== ''
								? { platform: l.platform.trim() }
								: {}),
						}));

					// Persist the raw payload verbatim (JSON-escaped) so pane render
					// bugs are diagnosable after the fact.
					const markdown = unwrapOuterFence(rawMarkdown);
					try {
						mkdirSync(PANE_LOG_DIR, { recursive: true });
						appendFileSync(
							join(PANE_LOG_DIR, 'pin-pane.log'),
							`${new Date().toISOString()} ${sessionId} title=${JSON.stringify(title)} unwrapped=${markdown !== rawMarkdown} markdown=${JSON.stringify(rawMarkdown)}\n`
						);
					} catch {
						// Diagnostics only — never block the pane on log I/O.
					}

					logger.info('[pin-pane] set_pin_pane called', {
						sessionId,
						title,
						width: requestedWidth,
						height: appliedHeight,
						markdownLength: markdown.length,
					});
					send({
						type: 'pin_pane_set',
						sessionId,
						title,
						markdown,
						width: requestedWidth,
						height: appliedHeight,
						columns: appliedColumns,
						...(appliedLinks.length > 0 ? { links: appliedLinks } : {}),
					});
					return {
						status: 'rendered',
						appliedWidth: requestedWidth,
						appliedHeight,
						appliedColumns,
						appliedLinks: appliedLinks.length,
					};
				};
				gemini.onClearPinPane = () => {
					logger.info('[pin-pane] clear_pin_pane called', { sessionId });
					send({ type: 'pin_pane_clear', sessionId });
					return { status: 'cleared' };
				};
				gemini.onMinimizePinPane = () => {
					logger.info('[pin-pane] minimize_pin_pane called', { sessionId });
					send({ type: 'pin_pane_minimize', sessionId });
					return { status: 'minimized' };
				};

				// A bad Gemini key or exhausted quota throws here (connect is the
				// first real call to the API). Classify it, tear the half-built
				// session down, and reject with a structured error the client can
				// turn into the right popup.
				try {
					await gemini.connect({ resumeHandle });
				} catch (err) {
					const classified = classifyProviderError('gemini', err);
					logger.warn('Gemini connect failed — rejecting session', {
						sessionId,
						kind: classified.kind,
						reason: classified.reason,
					});
					await gemini.close().catch(() => {});
					apiSessions.delete(sessionId);
					deleteSession(sessionId);
					clearSessionHistory(sessionId);
					ws.getUserData().sessionId = null;
					send({
						type: 'session_error',
						reason: classified.reason,
						kind: classified.kind,
						provider: classified.provider,
					});
					return;
				}

				ws.send(
					JSON.stringify({
						type: 'session_init',
						sessionId,
					} satisfies ServerMessage)
				);
				logger.info(resumeHandle ? 'Session resumed' : 'Session started', {
					sessionId,
					activeSessions: sessionCount(),
				});
				return;
			}

			if (msg.type === 'session_end') {
				const sessionId = ws.getUserData().sessionId;
				if (!sessionId) return;
				send({ type: 'pin_pane_clear', sessionId });
				const apiSession = apiSessions.get(sessionId);
				if (apiSession) {
					// Stop any in-flight research/automation so it doesn't run on
					// orphaned after the client is gone.
					apiSession.taskManager.cancel();
					emitSessionSummary(sessionId, apiSession);
					await apiSession.gemini.close();
					apiSessions.delete(sessionId);
				}
				deleteSession(sessionId);
				clearSessionHistory(sessionId);
				ws.getUserData().sessionId = null;
				logger.info('Session ended by client', { sessionId, activeSessions: sessionCount() });
				return;
			}

			// Keepalive — no-op. Its only job is to keep the socket (and the
			// extension's service worker) alive; it needs no active session.
			if (msg.type === 'ping') {
				return;
			}

			// All other messages require an active session
			const sessionId = ws.getUserData().sessionId;
			if (!sessionId) {
				logger.warn('Message received with no active session', { type: msg.type });
				return;
			}
			const apiSession = apiSessions.get(sessionId);
			if (!apiSession) return;

			if (msg.type === 'audio_chunk') {
				apiSession.gemini.sendAudio(msg.data);
				return;
			}

			if (msg.type === 'agent_observation') {
				apiSession.taskManager.handleAgentObservation(msg);
				return;
			}

			if (msg.type === 'agent_action_result') {
				apiSession.taskManager.handleAgentActionResult(msg);
				return;
			}

			if (msg.type === 'vision_frame') {
				apiSession.taskManager.handleVisionFrame(msg);
				return;
			}

			if (msg.type === 'screenshot_response') {
				apiSession.taskManager.handleScreenshotResponse(msg);
				return;
			}

			if (msg.type === 'page_data_response') {
				apiSession.taskManager.handlePageDataResponse(msg);
				return;
			}

			logger.warn('Unhandled message type', {
				sessionId,
				type: (msg as ExtensionMessage).type,
			});
		},

		async close(ws, code) {
			ws.getUserData().closed = true;
			const sessionId = ws.getUserData().sessionId;
			if (sessionId) {
				const apiSession = apiSessions.get(sessionId);
				if (apiSession) {
					// Stop in-flight tasks — the client is gone, so any running
					// automation/research would otherwise loop until it times out.
					apiSession.taskManager.cancel();
					emitSessionSummary(sessionId, apiSession, code);
					await apiSession.gemini.close();
					apiSessions.delete(sessionId);
				}
				deleteSession(sessionId);
				logger.info('WS closed', {
					sessionId,
					code,
					activeSessions: sessionCount(),
				});
			} else {
				logger.debug('WS closed — no active session', { code });
			}
		},
	});

	let listenSocket: us_listen_socket | false = false;
	app.listen(PORT, (token) => {
		if (token) {
			listenSocket = token;
			logger.info('Server listening', { port: PORT });
		} else {
			logger.fatal('Failed to start server', { port: PORT });
			process.exit(1);
		}
	});
	return listenSocket;
}
