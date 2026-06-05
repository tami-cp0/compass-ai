import { connectRedis } from '../infra/redis.js';
import { startServer } from './server.js';
import { logger } from '../infra/logger.js';

async function main() {
	logger.info('Starting Compass API', {
		nodeEnv: process.env.NODE_ENV,
		geminiModel: process.env.GEMINI_LIVE_MODEL,
		researchModel: process.env.OPENAI_RESEARCH_MODEL,
		webModel: process.env.OPENAI_WEB_MODEL,
	});
	await connectRedis();
	startServer();
}

main().catch((err: unknown) => {
	logger.fatal('Startup failed', { error: err instanceof Error ? err : new Error(String(err)) });
	process.exit(1);
});
