// Classifies an error thrown by a provider SDK (Google GenAI / Anthropic) into
// the machine-readable kind + provider the extension uses to pick an error
// popup. Verified against the providers' own docs (branch on status code +
// type/reason, NOT human message text, which the docs warn will drift):
//
//   Anthropic (https://platform.claude.com/docs/en/api/errors)
//     401 authentication_error → invalid key
//     402 billing_error        → out of credits
//     403 permission_error     → invalid key (key exists but can't be used)
//   Google GenAI
//     400 INVALID_ARGUMENT + reason API_KEY_INVALID → invalid key
//     429 RESOURCE_EXHAUSTED                        → out of credits / quota
//
// Anything unrecognized falls through to kind "other" so the caller can decide
// whether to surface it or just log.

export type ErrorKind = 'credits' | 'invalid_key' | 'missing_key' | 'other';
export type Provider = 'gemini' | 'claude';

export interface ClassifiedError {
	kind: ErrorKind;
	provider: Provider;
	reason: string;
}

// Best-effort extraction of an HTTP-ish status from either SDK's error object.
function statusOf(err: unknown): number | undefined {
	if (err && typeof err === 'object') {
		const e = err as { status?: unknown; code?: unknown };
		if (typeof e.status === 'number') return e.status;
		if (typeof e.code === 'number') return e.code; // Google ApiError uses `code`
	}
	return undefined;
}

// Google's 400 covers many argument errors; only the API_KEY_INVALID reason
// means the key itself is bad. The reason string appears in the error message
// and/or a nested details[].reason — check the serialized error text for it.
function looksLikeGeminiInvalidKey(err: unknown): boolean {
	const text = err instanceof Error ? err.message : String(err);
	return /API_KEY_INVALID/i.test(text) || /API key not valid/i.test(text);
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function classifyProviderError(provider: Provider, err: unknown): ClassifiedError {
	const status = statusOf(err);
	const base = messageOf(err);

	if (provider === 'claude') {
		if (status === 401 || status === 403)
			return { kind: 'invalid_key', provider, reason: `Claude rejected the API key (${status}).` };
		if (status === 402)
			return { kind: 'credits', provider, reason: 'Claude reports the account is out of credits (402).' };
		return { kind: 'other', provider, reason: base };
	}

	// gemini
	if (status === 429)
		return { kind: 'credits', provider, reason: 'Gemini quota exhausted (429).' };
	if (status === 400 && looksLikeGeminiInvalidKey(err))
		return { kind: 'invalid_key', provider, reason: 'Gemini rejected the API key (API_KEY_INVALID).' };
	// A bad key can also surface without a clean 400 on the live socket; catch it
	// by reason text as a fallback.
	if (looksLikeGeminiInvalidKey(err))
		return { kind: 'invalid_key', provider, reason: 'Gemini rejected the API key (API_KEY_INVALID).' };
	return { kind: 'other', provider, reason: base };
}
