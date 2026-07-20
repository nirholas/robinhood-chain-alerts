/** Structured logging: one JSON object per line, machine-readable by default. */

/** Log levels, ordered. */
export const LEVELS = ['debug', 'info', 'warn', 'error'] as const

/** A log level. */
export type LogLevel = (typeof LEVELS)[number]

/** Structured fields attached to a log line. */
export type LogFields = Record<string, unknown>

/** The logger the service uses everywhere. */
export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** A logger that adds `fields` to every line, for per-component context. */
  child(fields: LogFields): Logger
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level emitted. @defaultValue `'info'` */
  level?: LogLevel
  /** Where lines go. @defaultValue `console.log` */
  write?: (line: string) => void
  /** Fields added to every line. */
  base?: LogFields
  /** Clock injection point for tests. @defaultValue `Date.now` */
  now?: () => number
}

/**
 * Serialize a value that may contain a bigint or an Error. Log lines must
 * never throw: a `TypeError: Do not know how to serialize a BigInt` inside an
 * error handler loses the error it was reporting.
 */
function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (typeof raw === 'bigint') return raw.toString()
    if (raw instanceof Error) return { name: raw.name, message: raw.message, stack: raw.stack }
    return raw
  })
}

/** Build a structured logger. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = LEVELS.indexOf(options.level ?? 'info')
  const write = options.write ?? ((line: string): void => console.log(line))
  const now = options.now ?? Date.now
  const base = options.base ?? {}

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVELS.indexOf(level) < minimum) return
    write(
      safeStringify({
        time: new Date(now()).toISOString(),
        level,
        message,
        ...base,
        ...(fields ?? {}),
      }),
    )
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child(fields: LogFields): Logger {
      return createLogger({ ...options, base: { ...base, ...fields } })
    },
  }
}

/** A logger that discards everything. For tests and for `--quiet`. */
export function createSilentLogger(): Logger {
  const silent: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silent,
  }
  return silent
}
