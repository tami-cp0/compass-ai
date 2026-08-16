import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let sql: NeonQueryFunction<false, false> | null = null;

function db(): NeonQueryFunction<false, false> | null {
	if (sql) return sql;
	const url = process.env.DATABASE_URL;
	if (!url) return null;
	sql = neon(url);
	return sql;
}

// Create the table if needed. Called once at startup.
export async function initEmailStore(): Promise<void> {
	const q = db();
	if (!q) return;
	await q`CREATE TABLE IF NOT EXISTS emails (email TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
}

export async function recordEmail(rawEmail: string): Promise<void> {
	const q = db();
	if (!q) return;
	const email = rawEmail.trim().toLowerCase();
	if (!email) return;
	await q`INSERT INTO emails (email) VALUES (${email}) ON CONFLICT (email) DO NOTHING`;
}
