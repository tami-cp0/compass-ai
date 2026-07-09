import { App, DISABLED, type us_listen_socket } from 'uWebSockets.js';
import { v4 as uuidv4 } from 'uuid';
import type { ExtensionMessage, ServerMessage } from '@compass-ai/types';
import { createSession, deleteSession, sessionCount } from './session-store.js';
import { logger, sessionLogger } from '../infra/logger.js';
import { GeminiLiveSession } from '../agents/conversation/gemini-live-session.js';
import {
	deleteResumptionHandle,
	getConversationHistory,
	getResumptionHandle,
} from '../infra/redis.js';
import { TaskManager } from './task-manager.js';
import { unwrapOuterFence } from './pane-estimate.js';
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

const apiSessions = new Map<string, ApiSession>();

function emitSessionSummary(sessionId: string, apiSession: ApiSession, closeCode?: number, closeReason?: string): void {
	const log = sessionLogger(sessionId);
	const m = apiSession.taskManager.metrics;
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
				// (i.e. handle is in Redis). Otherwise we start clean with a new id.
				const resumeHandle =
					msg.type === 'session_resume'
						? await getResumptionHandle(msg.sessionId)
						: null;
				const sessionId =
					resumeHandle && msg.type === 'session_resume' ? msg.sessionId : uuidv4();
				ws.getUserData().sessionId = sessionId;

				const history = await getConversationHistory(sessionId);
				const session = createSession(sessionId, send);
				const gemini = new GeminiLiveSession(sessionId, send, history);
				const taskManager = new TaskManager(session, gemini);
				apiSessions.set(sessionId, { sessionId, gemini, taskManager, startedAt: Date.now() });

				gemini.onDispatchResearch = (name, desc, profile) =>
					taskManager.dispatchResearch(name, desc, profile);
				gemini.onDispatchAutomation = (name, desc) =>
					taskManager.dispatchAutomation(name, desc);
				gemini.onCancelTask = (name) => taskManager.cancel(name);
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

				await gemini.connect({ resumeHandle });

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
					emitSessionSummary(sessionId, apiSession);
					await apiSession.gemini.close();
					apiSessions.delete(sessionId);
				}
				deleteSession(sessionId);
				await deleteResumptionHandle(sessionId);
				ws.getUserData().sessionId = null;
				logger.info('Session ended by client', { sessionId, activeSessions: sessionCount() });
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
