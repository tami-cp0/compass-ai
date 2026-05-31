import { b } from "../baml_client/index.js"
import type { WebAgentOutput } from "../baml_client/types.js"
import { logger } from "./logger.js"

export async function runWebAgent(
  task:       string,
  elementMap: string,
  screenshot: string,
): Promise<WebAgentOutput> {
  const result = await b.WebAgent(task, elementMap, screenshot)
  logger.info("WebAgent planned", { task, actionCount: result.actions.length })
  return result
}
