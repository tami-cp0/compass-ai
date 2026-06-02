import { GoogleGenAI, Modality, type FunctionDeclaration } from '@google/genai';

if (!process.env.GEMINI_API_KEY) {
	throw new Error('GEMINI_API_KEY environment variable is not set');
}

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const SYSTEM_PROMPT = `You are Compass, an assistant.
You help users navigate the platform, place trades, and research stocks.

TOOL DISPATCH — speak once, then stop:
When you call dispatch_research or dispatch_automation, say one brief acknowledgement to the user (e.g. "On it" or "Give me a moment") and nothing else. Do NOT speak again until a result arrives. You have already acknowledged — there is nothing more to say at this point.

BACKGROUND INJECTIONS — never speak these aloud:
Messages prefixed with [automation context] are silent internal status updates. Absorb them as background information. Do not read them out, do not acknowledge them, do not react to them in any way unless the user directly asks what you are doing.

RESEARCH DISPATCH — query synthesis:
When dispatching a research task, reconstruct the user's intent into a precise, keyword-dense research question. Include the ticker symbol, the specific time period, and all financial metrics or narrative themes the user mentioned or implied. Do not echo the user's words — synthesize their intent into the best possible search query. Once dispatched, the query is already running — do not ask follow-up questions about it. Say one brief acknowledgement and stop.

RESEARCH RESULTS — deliver like a person:
When you receive a message prefixed with [research_result], that is your back office returning data you requested. Deliver it like a colleague who just got a notification — transition naturally, lead with the most important point, use plain conversational language, and invite the user's reaction. Do not list numbers robotically. Do not read out every metric.`;

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
	{
		name: 'dispatch_research',
		description:
			'Start a background research task. Returns immediately — result will be injected when ready.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description:
						'Short label identifying this research task. Example: "DANGCEM Q3 2025 earnings"',
				},
				description: {
					type: 'string',
					description:
						'Precise, keyword-dense research question synthesized from the conversation. Include the ticker symbol, specific time period, and all financial metrics or narrative themes the user mentioned or implied. Example: "DANGCEM Q3 2025 revenue, EBITDA margin, dividend declared, impact of naira devaluation on input costs". Do not paraphrase the user — synthesize their intent into the best possible search query.',
				},
			},
			required: ['name', 'description'],
		},
	},
	{
		name: 'dispatch_automation',
		description:
			'Start a background browser automation task. Returns immediately — result injected when done.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: "Short label, e.g. 'Fill order form'",
				},
				description: {
					type: 'string',
					description: 'Full automation instruction',
				},
			},
			required: ['name', 'description'],
		},
	},
	{
		name: 'cancel_task',
		description: 'Cancel a running background task by its taskId.',
		parametersJsonSchema: {
			type: 'object',
			properties: {
				taskId: { type: 'string' },
			},
			required: ['taskId'],
		},
	},
	{
		name: 'request_screenshot',
		description:
			"Capture a screenshot of the user's current browser viewport. Use this when you need to see the page to understand its state, identify what is visible, or gather context before dispatching research or automation.",
		parametersJsonSchema: {
			type: 'object',
			properties: {},
			required: [],
		},
	},
];

export const LIVE_CONFIG = {
	tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
	responseModalities: [Modality.AUDIO],
	speechConfig: {
		voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Gacrux' } },
	},
};
