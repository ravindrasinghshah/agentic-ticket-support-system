/**
 * Structured JSON logging keyed by ticket_id + conversation_id.
 *
 * ARCHITECTURE.md §11: the supervisor and every Lambda emit structured JSON carrying
 * ticket_id, conversation_id, tool name, verdict/reason codes, and latency. No free-text-only
 * log lines on the request path — CloudWatch Logs Insights has to be able to query them.
 *
 * The sink and the clock are injected so tests can assert on emitted records without
 * capturing stdout, and the level is passed in rather than read from the environment — this
 * module deliberately does not touch process.env (config.ts is the only module that does).
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Correlation fields carried on every line a logger emits. */
export interface LogContext {
  /** Which component emitted the line: 'supervisor', 'lambda.refund', 'doctor', … */
  component: string;
  ticketId?: string;
  conversationId?: string;
  /** Specialist tool name, when the line is about a tool call. */
  tool?: string;
  [key: string]: unknown;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  component: string;
  ticket_id?: string;
  conversation_id?: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Narrow the logger with more correlation fields — e.g. once a ticket_id is known. */
  child(context: Partial<LogContext>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
}

/** Default sink: one JSON object per line on stdout, which is what CloudWatch ingests. */
export const stdoutSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

/**
 * Errors do not serialize under JSON.stringify — `{}` is a common and painful log bug.
 * Unwrap them into something queryable.
 */
function normalizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value;
  }
  return out;
}

export function createLogger(context: LogContext, options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_RANK[level];

  const { component, ticketId, conversationId, ...rest } = context;

  function emit(recordLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[recordLevel] < threshold) return;
    const record: LogRecord = {
      timestamp: now().toISOString(),
      level: recordLevel,
      message,
      component,
      ...(ticketId !== undefined ? { ticket_id: ticketId } : {}),
      ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
      ...rest,
      ...normalizeFields(fields),
    };
    sink(record);
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra) => createLogger({ ...context, ...extra } as LogContext, options),
  };
}
