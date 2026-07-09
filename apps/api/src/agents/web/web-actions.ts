import type { ActionVariant } from '@compass-ai/types';

// The OpenAI structured-output schema for one agent step.
// Each action is a separate variant in an anyOf; the model picks the variant
// and provides only that variant's fields. Coordinates are integers in
// CSS-pixel space at the resolution given by the observation.
export const WEB_AGENT_STEP_SCHEMA = {
	type: 'json_schema' as const,
	name: 'agent_step',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			reasoning: { type: 'string' },
			progress_note: { type: 'string' },
			page_changed: { type: 'boolean' },
			actions: {
				type: 'array',
				items: {
					anyOf: [
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['mouse:click'] },
								x: { type: 'integer' },
								y: { type: 'integer' },
							},
							required: ['variant', 'x', 'y'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['mouse:double_click'] },
								x: { type: 'integer' },
								y: { type: 'integer' },
							},
							required: ['variant', 'x', 'y'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['mouse:right_click'] },
								x: { type: 'integer' },
								y: { type: 'integer' },
							},
							required: ['variant', 'x', 'y'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['mouse:drag'] },
								from: {
									type: 'object',
									additionalProperties: false,
									properties: { x: { type: 'integer' }, y: { type: 'integer' } },
									required: ['x', 'y'],
								},
								to: {
									type: 'object',
									additionalProperties: false,
									properties: { x: { type: 'integer' }, y: { type: 'integer' } },
									required: ['x', 'y'],
								},
							},
							required: ['variant', 'from', 'to'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['mouse:scroll'] },
								x: { type: 'integer' },
								y: { type: 'integer' },
								deltaX: { type: 'integer' },
								deltaY: { type: 'integer' },
							},
							required: ['variant', 'x', 'y', 'deltaX', 'deltaY'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['keyboard:type'] },
								content: { type: 'string' },
							},
							required: ['variant', 'content'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['keyboard:enter'] },
							},
							required: ['variant'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['keyboard:tab'] },
							},
							required: ['variant'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['keyboard:backspace'] },
							},
							required: ['variant'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['keyboard:select_all'] },
							},
							required: ['variant'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['browser:nav'] },
								url: { type: 'string' },
							},
							required: ['variant', 'url'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['browser:nav:back'] },
							},
							required: ['variant'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['browser:tab:switch'] },
								index: { type: 'integer' },
							},
							required: ['variant', 'index'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['browser:tab:new'] },
							},
							required: ['variant'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['wait'] },
								seconds: { type: 'number' },
							},
							required: ['variant', 'seconds'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['page:read'] },
								x: { type: 'integer' },
								y: { type: 'integer' },
								width: { type: 'integer' },
								height: { type: 'integer' },
							},
							required: ['variant', 'x', 'y', 'width', 'height'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['task:done'] },
								evidence: { type: 'string' },
							},
							required: ['variant', 'evidence'],
						},
						{
							type: 'object',
							additionalProperties: false,
							properties: {
								variant: { type: 'string', enum: ['task:fail'] },
								reason: { type: 'string' },
							},
							required: ['variant', 'reason'],
						},
					],
				},
			},
		},
		required: ['reasoning', 'progress_note', 'page_changed', 'actions'],
	},
};

// Compact reference rendered into the system prompt so the model knows what
// each variant means. Mirrors the descriptions on pear's webActions/taskActions.
export const ACTION_VOCABULARY_HELP = `
Available actions (emit one or more per step, executed serially):

- mouse:click { x, y } — click at CSS-pixel coordinates
- mouse:double_click { x, y }
- mouse:right_click { x, y }
- mouse:drag { from: {x,y}, to: {x,y} } — click-hold and release at another point
- mouse:scroll { x, y, deltaX, deltaY } — hover mouse over (x,y) and scroll
- keyboard:type { content } — make sure to click the target input first; use literal "<enter>" or "<tab>" inside content to interleave key presses
- keyboard:enter
- keyboard:tab
- keyboard:backspace
- keyboard:select_all — Ctrl+A (Cmd+A on macOS)
- browser:nav { url } — navigate the active tab directly
- browser:nav:back
- browser:tab:switch { index } — switch to an already-open tab by index
- browser:tab:new — open and switch to a new tab
- wait { seconds } — actions already wait for stability; only use when a clearly larger wait is required
- page:read { x, y, width, height } — return the EXACT visible text inside this box (CSS-pixel coords on the current screenshot). Use it to read precise figures the screenshot might render too small to trust; box tightly around only what you need. The text comes back on next turn's result.
- task:done { evidence } — finish successfully; evidence MUST cite specific observable content from the current screenshot (a number, a row, a title)
- task:fail { reason } — task is impossible or you have tried and exhausted alternatives
`.trim();

export const TERMINAL_VARIANTS: readonly ActionVariant[] = [
	'task:done',
	'task:fail',
] as const;
