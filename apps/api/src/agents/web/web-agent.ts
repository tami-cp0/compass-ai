import { Image } from '@boundaryml/baml';
import { b } from '../../../baml_client/index.js';
import type { StepRecord, WebAgentStep } from '../../../baml_client/types.js';
import { logger } from '../../infra/logger.js';

export function dataUrlToImage(dataUrl: string): Image {
	const [header, base64] = dataUrl.split(',');
	const mediaType = header.replace('data:', '').replace(';base64', '');
	return Image.fromBase64(mediaType, base64);
}

export async function webAgentNextStep(
	task: string,
	elementMap: string | null,
	screenshot: string,
	history: StepRecord[]
): Promise<WebAgentStep> {
	const result = await b.WebAgentNextStep(
		task,
		elementMap,
		dataUrlToImage(screenshot),
		history
	);
	logger.info('WebAgent step planned', {
		task,
		stepNumber: history.length + 1,
		hadElementMap: elementMap !== null,
		needsElementMap: result.needs_element_map,
		isComplete: result.is_complete,
		isFailed: result.is_failed,
		action: result.next_action?.action,
		reasoning: result.reasoning,
	});
	return result;
}
