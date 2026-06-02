import { App, DISABLED } from 'uWebSockets.js';
import { v4 as uuidv4 } from 'uuid';
import type { ExtensionMessage, ServerMessage } from '@compass-ai/types';
import { createSession, deleteSession, sessionCount } from './session-store.js';
import { logger } from '../infra/logger.js';
import { GeminiLiveSession } from '../agents/conversation/gemini-live-session.js';
import { getConversationHistory } from '../infra/redis.js';
import { TaskManager } from './task-manager.js';

const PORT = Number(process.env.PORT ?? 8787);

interface ApiSession {
	sessionId: string;
	gemini: GeminiLiveSession;
	taskManager: TaskManager;
}

const apiSessions = new Map<string, ApiSession>();

export function startServer(): void {
	const app = App();

	app.ws<{ sessionId: string | null }>('/ws', {
		compression: DISABLED,
		maxPayloadLength: 16 * 1024 * 1024,
		idleTimeout: 120,

		open(ws) {
			ws.getUserData().sessionId = null;
			logger.info('WS connection opened — waiting for session_start');
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

			const send = (m: ServerMessage) => ws.send(JSON.stringify(m));

			if (msg.type === 'session_start') {
				// Tear down any existing session on this WS first (re-start)
				const existing = ws.getUserData().sessionId;
				if (existing) {
					const prev = apiSessions.get(existing);
					if (prev) {
						await prev.gemini.close();
						apiSessions.delete(existing);
					}
					deleteSession(existing);
					logger.info('Previous session torn down for re-start', { sessionId: existing });
				}

				const sessionId = uuidv4();
				ws.getUserData().sessionId = sessionId;

				const history = await getConversationHistory(sessionId);
				const session = createSession(sessionId, send);
				const gemini = new GeminiLiveSession(sessionId, send, history);
				const taskManager = new TaskManager(session, gemini);
				apiSessions.set(sessionId, { sessionId, gemini, taskManager });

				gemini.onDispatchResearch = (name, desc) =>
					taskManager.dispatchResearch(name, desc);
				gemini.onDispatchAutomation = (name, desc) =>
					taskManager.dispatchAutomation(name, desc);
				gemini.onCancelTask = (taskId) => taskManager.cancel(taskId);

				await gemini.connect();

				ws.send(
					JSON.stringify({
						type: 'session_init',
						sessionId,
					} satisfies ServerMessage)
				);
				logger.info('Session started', { sessionId, total: sessionCount() });
				return;
			}

			if (msg.type === 'session_end') {
				const sessionId = ws.getUserData().sessionId;
				if (!sessionId) return;
				const apiSession = apiSessions.get(sessionId);
				if (apiSession) {
					await apiSession.gemini.close();
					apiSessions.delete(sessionId);
				}
				deleteSession(sessionId);
				ws.getUserData().sessionId = null;
				logger.info('Session ended by client', { sessionId, total: sessionCount() });
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

			if (msg.type === 'dom_snapshot') {
				apiSession.taskManager.handleDomSnapshot(msg);
				return;
			}

			if (msg.type === 'action_result') {
				apiSession.taskManager.handleActionResult(msg);
				return;
			}

			if (msg.type === 'user_action_result') {
				apiSession.taskManager.handleUserActionResult(msg);
				return;
			}

			if (msg.type === 'screenshot_response') {
				apiSession.taskManager.handleScreenshotResponse(msg);
				return;
			}

			logger.warn('Unhandled message type', {
				sessionId,
				type: (msg as ExtensionMessage).type,
			});
		},

		async close(ws, code) {
			const sessionId = ws.getUserData().sessionId;
			if (sessionId) {
				const apiSession = apiSessions.get(sessionId);
				if (apiSession) {
					await apiSession.gemini.close();
					apiSessions.delete(sessionId);
				}
				deleteSession(sessionId);
				logger.info('WS closed — session torn down', {
					sessionId,
					code,
					total: sessionCount(),
				});
			} else {
				logger.info('WS closed — no active session', { code });
			}
		},
	});

	app.listen(PORT, (token) => {
		if (token) {
			logger.info('Server listening', { port: PORT });
		} else {
			logger.error('Failed to start server', { port: PORT });
			process.exit(1);
		}
	});
}
