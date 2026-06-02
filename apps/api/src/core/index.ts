import { connectRedis } from '../infra/redis.js';
import { startServer } from './server.js';
import { logger } from '../infra/logger.js';

async function main() {
	logger.info('Starting Compass API');
	await connectRedis();
	startServer();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
