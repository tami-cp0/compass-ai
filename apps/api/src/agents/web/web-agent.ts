import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import OpenAI from 'openai'
import type { WebAgentStep, StepRecord } from '@compass-ai/types'
import { logger } from '../../infra/logger.js'
import type { TokenUsage } from '../../infra/token-tracker.js'

if (!process.env.OPENAI_API_KEY) {
	throw new Error('OPENAI_API_KEY environment variable is not set')
}

if (!process.env.OPENAI_VECTOR_STORE_ID) {
	throw new Error('OPENAI_VECTOR_STORE_ID environment variable is not set')
}

if (!process.env.OPENAI_WEB_MODEL) {
	throw new Error('OPENAI_WEB_MODEL environment variable is not set')
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID

// Read once at module load — stable string ensures OpenAI prompt cache always hits
const _dir = dirname(fileURLToPath(import.meta.url))
const platformContext = readFileSync(join(_dir, '../../assets/platform_context.xml'), 'utf-8')

const SYSTEM_PROMPT = `You are a web automation agent. One action per turn.

REASONING ORDER — follow this exactly:
1. Look at the screenshot first. Understand what is currently visible on screen.
2. Check the history to understand what has been tried.
3. Decide what to do next.

RULES:
- element_id MUST exist in the element map — never invent one.
- If target not in map, reveal it first (scroll, open menu).
- is_complete: ONLY set true when you are on a verify turn — you just received a screenshot after your last action and can visually confirm the task is done. NEVER set is_complete on the same turn you output a next_action.
- is_failed: True if the task is structurally impossible or the same action has failed on the same element three times. Try an alternative before failing.
- isCritical: True ONLY when submitting a buy or sell order — the final confirmation action that executes a trade. All other actions including navigating to order forms, filling in quantities, selecting order types, and any confirmation dialogs unrelated to trade execution should be automated without pause.
- If you see skeleton loaders, spinners, or blank content, do not fail — scroll slightly to confirm the page is live and re-observe.
- Typing into a search bar does nothing on its own. After typing, always look for a magnifying glass icon and click it to trigger the search. If no magnifying glass is present, press Enter instead.

PLATFORM — Atlass Portfolios (CitiTrader, NGX only):
The descriptions below are partial — every page is more complex than described. Treat them as orientation, not complete maps. Always observe the screenshot first and reason from what you actually see, not from assumptions about what should be there.

- Single-page app. No URL changes ever. Navigation is sidebar menu clicks only — never type or navigate to a URL.
- No semantic HTML — the entire platform is div-based. Always rely on the element map for targeting. Never guess element IDs.
- Horizontal scrolling is common on pages like Portfolio and other components. Use scroll left/right when content appears cut off.

SIDEBAR MENU (all available pages):
My Reports, List Accounts, Dashboard, Certificates, Portfolio
PAYMENTS: Withdrawal Request
MANDATES: New Mandate, Manage Mandates
TRADE REAL-TIME: Buy Orders, Sell Orders, Import Mandates, Order History
MY EXECUTIONS (TRADES): Summary, Details
MARKET: Market View, Trades, Statistics, Manage Watchlist, Price/Volume Chart, Securities, Reports, News
HELP & SUPPORT: Quick Help, Service Request, Disclaimer

MARKET VIEW:
- Lists all NGX investable instruments across all boards, in alphabetical order. Scrollable.
- Board filter dropdown to narrow by board type (e.g. ETF).
- Symbol search: type ticker in the search bar → click the magnifying glass icon (typing alone does not trigger search) → platform auto-scrolls to that ticker in the alphabetical list.
- Beside each ticker: a dropdown arrow (upside-down triangle) → reveals three options: Buy, Sell, Market Orders.
- Market Orders is a nested dropdown → By Order or By Price → clicking either opens the full order book for that instrument.

ORDER BOOK (bottom-left, labelled "Orders"):
- Split into two panels: left panel is the buy order book (blue background), right panel is the sell order book (red background).
- Both panels are scrollable if content overflows.

TRADES (bottom-right, labelled "Trades"):
- Live feed of other traders' executed buy and sell orders. Moves fast. Read-only.

STATISTICS:
- Shows top gainers, top losers, most traded by value, most traded by volume across NGX.

PRICE/VOLUME CHART:
- Shows the price and volume chart for a specific stock. Has its own symbol search bar — type ticker and search to load the chart.

FULL PLATFORM CONTEXT:
${platformContext}`

const WEB_AGENT_SCHEMA = {
	type: 'json_schema' as const,
	name: 'web_agent_step',
	strict: true,
	schema: {
		type: 'object',
		properties: {
			reasoning: { type: 'string' },
			next_action: {
				anyOf: [
					{ type: 'null' },
					{
						type: 'object',
						properties: {
							action: { type: 'string' },
							element_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
							value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
							direction: { anyOf: [{ type: 'string' }, { type: 'null' }] },
							amount: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
							text_snippet: { anyOf: [{ type: 'string' }, { type: 'null' }] },
							isCritical: { type: 'boolean' },
							description: { type: 'string' },
						},
						required: ['action', 'element_id', 'value', 'direction', 'amount', 'text_snippet', 'isCritical', 'description'],
						additionalProperties: false,
					},
				],
			},
			is_complete: { type: 'boolean' },
			is_failed: { type: 'boolean' },
		},
		required: ['reasoning', 'next_action', 'is_complete', 'is_failed'],
		additionalProperties: false,
	},
}

function buildHistoryText(history: StepRecord[]): string {
	if (history.length === 0) return ''
	return (
		'Recent steps:\n' +
		history.map((s) => `Step ${s.step_number}: ${s.action_description} → ${s.outcome}`).join('\n') +
		'\n\n'
	)
}

export async function webAgentNextStep(
	task: string,
	elementMap: string,
	screenshot: string,
	history: StepRecord[]
): Promise<{ step: WebAgentStep; usage: TokenUsage }> {
	const historyText = buildHistoryText(history)

	const response = await openai.responses.create({
		model: process.env.OPENAI_WEB_MODEL!,
		tools: [{ type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }],
		input: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				content: [
					{
						type: 'input_text',
						text: `${historyText}Task: ${task}\n\nCurrent page:`,
					},
					{
						type: 'input_image',
						image_url: screenshot,
						fidelity: "high"
					},
					{
						type: 'input_text',
						text: `Elements (only these IDs are valid):\n${elementMap}`,
					},
				] as any,
			},
		],
		max_output_tokens: 800,
		text: { format: WEB_AGENT_SCHEMA },
	})

	const outputText = response.output
		.filter((block) => block.type === 'message')
		.flatMap((block) => {
			if (block.type !== 'message') return []
			return block.content
				.filter((c): c is Extract<typeof c, { type: 'output_text' }> => c.type === 'output_text')
				.map((c) => c.text)
		})
		.join('')

	if (!outputText) throw new Error('WebAgent returned empty output')

	let parsed: WebAgentStep
	try {
		parsed = JSON.parse(outputText) as WebAgentStep
	} catch {
		throw new Error(`WebAgent returned unparseable JSON: ${outputText.slice(0, 200)}`)
	}

	logger.debug('WebAgent step planned', {
		stepNumber: history.length + 1,
		isComplete: parsed.is_complete,
		isFailed: parsed.is_failed,
		action: parsed.next_action?.action,
	})

	const u = response.usage
	const usage: TokenUsage = {
		inputTokens: u?.input_tokens ?? 0,
		outputTokens: u?.output_tokens ?? 0,
		totalTokens: u?.total_tokens ?? 0,
		cachedTokens: u?.input_tokens_details?.cached_tokens,
	}
	return { step: parsed, usage }
}
