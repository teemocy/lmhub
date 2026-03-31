import { type LogLevel, logLevelSchema } from "@localhub/shared-contracts/foundation-common";

export interface LogEntry {
  level: LogLevel;
  logger: string;
  message: string;
  ts: string;
  context: Record<string, unknown>;
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  name: string;
  level?: LogLevel;
  sink?: (entry: LogEntry) => void;
  bindings?: Record<string, unknown>;
  redactKeys?: string[];
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_REDACT_KEYS = ["authorization", "bearer", "token", "secret", "password", "apiKey"];

function shouldRedactKey(key: string, redactKeys: string[]): boolean {
  const lowerKey = key.toLowerCase();
  return redactKeys.some((candidate) => lowerKey.includes(candidate.toLowerCase()));
}

function redactValue(value: unknown, redactKeys: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactKeys));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        shouldRedactKey(key, redactKeys) ? "[redacted]" : redactValue(nestedValue, redactKeys),
      ]),
    );
  }

  return value;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const level = logLevelSchema.parse(options.level ?? "info");
  const sink =
    options.sink ??
    ((entry) => {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    });
  const redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;

  const emit = (
    entryLevel: LogLevel,
    message: string,
    context: Record<string, unknown> = {},
  ): void => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) {
      return;
    }

    sink({
      level: entryLevel,
      logger: options.name,
      message,
      ts: new Date().toISOString(),
      context: redactValue({ ...options.bindings, ...context }, redactKeys) as Record<
        string,
        unknown
      >,
    });
  };

  return {
    child(bindings) {
      return createLogger({
        ...options,
        bindings: { ...options.bindings, ...bindings },
      });
    },
    debug(message, context) {
      emit("debug", message, context);
    },
    info(message, context) {
      emit("info", message, context);
    },
    warn(message, context) {
      emit("warn", message, context);
    },
    error(message, context) {
      emit("error", message, context);
    },
  };
}
