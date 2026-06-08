import { us_listen_socket_close, type us_listen_socket } from 'uWebSockets.js';
import { connectRedis, redis } from '../infra/redis.js';
import { startServer, shutdownAllSessions } from './server.js';
import { logger } from '../infra/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

function shutdown(signal: string, listenSocket: us_listen_socket | false): void {
	if (shuttingDown) {
		logger.warn('Second signal received — forcing exit', { signal });
		process.exit(1);
	}
	shuttingDown = true;

	logger.info('Shutdown initiated', { signal });

	const timer = setTimeout(() => {
		logger.error('Shutdown timeout exceeded — forcing exit');
		process.exit(1);
	}, SHUTDOWN_TIMEOUT_MS);
	// Don't let this timer keep the event loop alive past process.exit
	timer.unref();

	void (async () => {
		try {
			// 1. Stop accepting new connections
			if (listenSocket) {
				us_listen_socket_close(listenSocket);
			}

			// 2. Close all active Gemini sessions (parallel, summarised)
			await shutdownAllSessions();

			// 3. Flush in-flight Redis commands and close the connection
			await redis.quit();

			logger.info('Shutdown complete');
		} catch (err: unknown) {
			logger.error('Error during shutdown', {
				error: err instanceof Error ? err : new Error(String(err)),
			});
		} finally {
			process.exit(0);
		}
	})();
}

async function main() {
	logger.info('Starting Compass API', {
		nodeEnv: process.env.NODE_ENV,
		geminiModel: process.env.GEMINI_LIVE_MODEL,
		researchModel: process.env.OPENAI_RESEARCH_MODEL,
		webModel: process.env.OPENAI_WEB_MODEL,
	});
	await connectRedis();
	const listenSocket = startServer();

	process.once('SIGTERM', () => shutdown('SIGTERM', listenSocket));
	process.once('SIGINT', () => shutdown('SIGINT', listenSocket));
}

main().catch((err: unknown) => {
	logger.fatal('Startup failed', { error: err instanceof Error ? err : new Error(String(err)) });
	process.exit(1);
});
