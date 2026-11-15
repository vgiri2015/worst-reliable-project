'use strict';

/**
 * Structured logger that writes every record twice:
 *   1. a JSON line on stdout/stderr (unchanged local/container log format), and
 *   2. an OpenTelemetry LogRecord exported over OTLP.
 *
 * Both carry the active trace_id/span_id, so a log line in the collector links
 * straight to the request trace that produced it.
 *
 *   const log = require('./log');
 *   log.error('[tomo-id-017] ...: customer analysis failed', { customerId, error: err });
 *
 * Field conventions:
 *   - `error` (an Error) is expanded to exception.type / exception.message / exception.stacktrace
 *   - a `[tomo-id-NNN]` prefix in the message becomes the `event.name` attribute
 *   - nested objects/arrays are JSON-encoded (OTLP attributes must be primitives)
 */

const { logs, trace, SeverityNumber } = require('@opentelemetry/api');
const { PACKAGE_VERSION } = require('./telemetry');

const otelLogger = logs.getLogger('worst-pri-product', PACKAGE_VERSION);

const LEVELS = {
  debug: { severityNumber: SeverityNumber.DEBUG, severityText: 'DEBUG', write: console.debug },
  info: { severityNumber: SeverityNumber.INFO, severityText: 'INFO', write: console.info },
  warn: { severityNumber: SeverityNumber.WARN, severityText: 'WARN', write: console.warn },
  error: { severityNumber: SeverityNumber.ERROR, severityText: 'ERROR', write: console.error },
};

const EVENT_ID = /\[(tomo-id-\d+)\]/;

function toAttributes(fields) {
  const attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (key === 'error' && value instanceof Error) {
      attributes['exception.type'] = value.name;
      attributes['exception.message'] = value.message;
      if (value.stack) attributes['exception.stacktrace'] = value.stack;
      continue;
    }
    attributes[key] = (typeof value === 'object') ? JSON.stringify(value) : value;
  }
  return attributes;
}

function emit(level, message, fields = {}) {
  const { severityNumber, severityText, write } = LEVELS[level];
  const spanContext = trace.getActiveSpan()?.spanContext();
  const attributes = toAttributes(fields);
  const eventId = EVENT_ID.exec(message)?.[1];
  if (eventId) attributes['event.name'] = eventId;

  write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...attributes,
    ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
  }));

  // trace/span correlation is taken from the active context automatically.
  otelLogger.emit({ severityNumber, severityText, body: message, attributes });
}

module.exports = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
