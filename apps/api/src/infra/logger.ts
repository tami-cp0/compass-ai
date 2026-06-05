import { hostname } from "os"
import pino, { type Logger as PinoLogger, type Level } from "pino"

const IS_DEV = process.env.NODE_ENV === "development"
const LEVEL = (process.env.LOG_LEVEL ?? (IS_DEV ? "debug" : "info")) as Level
const INSTANCE_ID = process.env.INSTANCE_ID ?? hostname()

// Sessions allowed to log at debug level even when global level is info.
// Lets prod operators target a specific user for diagnostics without flooding logs.
const DEBUG_SESSIONS = new Set(
  (process.env.DEBUG_SESSION_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

const base = pino({
  level: LEVEL,
  base: { instanceId: INSTANCE_ID },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Redact obvious PII-bearing fields wherever they appear in log bodies.
  redact: {
    paths: [
      "*.apiKey",
      "*.authorization",
      "*.cookie",
      "*.password",
      "*.token",
      "audio",
      "screenshot",
      "data",
    ],
    censor: "[redacted]",
    remove: false,
  },
  ...(IS_DEV
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,instanceId" },
        },
      }
    : {}),
})

export interface Logger {
  trace: (msg: string, meta?: Record<string, unknown>) => void
  debug: (msg: string, meta?: Record<string, unknown>) => void
  info: (msg: string, meta?: Record<string, unknown>) => void
  warn: (msg: string, meta?: Record<string, unknown>) => void
  error: (msg: string, meta?: Record<string, unknown>) => void
  fatal: (msg: string, meta?: Record<string, unknown>) => void
  child: (bindings: Record<string, unknown>) => Logger
}

function wrap(p: PinoLogger): Logger {
  const call =
    (level: Level) =>
    (msg: string, meta?: Record<string, unknown>) => {
      if (meta && meta.error instanceof Error) {
        const e = meta.error
        meta = { ...meta, error: { name: e.name, message: e.message, stack: e.stack, ...(e as unknown as { code?: string }).code ? { code: (e as unknown as { code: string }).code } : {} } }
      }
      p[level](meta ?? {}, msg)
    }

  return {
    trace: call("trace"),
    debug: call("debug"),
    info: call("info"),
    warn: call("warn"),
    error: call("error"),
    fatal: call("fatal"),
    child: (bindings) => wrap(p.child(bindings)),
  }
}

export const logger: Logger = wrap(base)

// Returns a child logger bound to a sessionId. If the session is on the
// DEBUG_SESSIONS allow-list, the child is forced to debug level so prod
// operators can diagnose a single user without raising the global level.
export function sessionLogger(sessionId: string): Logger {
  const child = base.child({ sessionId })
  if (DEBUG_SESSIONS.has(sessionId)) {
    child.level = "debug"
  }
  return wrap(child)
}
