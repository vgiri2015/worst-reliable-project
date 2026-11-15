'use strict';

/**
 * OpenTelemetry bootstrap — traces, metrics and logs over OTLP.
 *
 * MUST be the first thing a process loads (before express/http/undici are
 * required) so the auto-instrumentations can patch those modules:
 *
 *   require('./telemetry').start({ serviceName: 'worst-pri-product' });
 *
 * Everything is driven by the standard OTEL_* environment variables, so the
 * same code works locally, in Docker and in k8s:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   collector base URL   (default http://localhost:4318)
 *   OTEL_SERVICE_NAME             overrides the serviceName passed to start()
 *   OTEL_RESOURCE_ATTRIBUTES      extra resource attributes (k=v,k2=v2)
 *   OTEL_METRIC_EXPORT_INTERVAL   metric push interval ms (default here: 10000)
 *   OTEL_TRACES_SAMPLER(_ARG)     sampling (default parentbased_always_on)
 *   OTEL_LOG_LEVEL                SDK self-diagnostics (default: warn)
 *   OTEL_SDK_DISABLED=true        turn telemetry off entirely (no-op API)
 */

const { diag, DiagLogLevel } = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const SERVICE_VERSION = require('../package.json').version;
const SERVICE_NAMESPACE = 'worst-pri';

let sdk = null;
let shutdownPromise = null;

// SDK self-diagnostics (e.g. "collector unreachable") as structured JSON on
// stderr, matching the rest of the app's log format.
function installDiagLogger() {
  const levels = { none: DiagLogLevel.NONE, error: DiagLogLevel.ERROR, warn: DiagLogLevel.WARN, info: DiagLogLevel.INFO, debug: DiagLogLevel.DEBUG, verbose: DiagLogLevel.VERBOSE, all: DiagLogLevel.ALL };
  const level = levels[String(process.env.OTEL_LOG_LEVEL || 'warn').toLowerCase()] ?? DiagLogLevel.WARN;
  const write = (lvl) => (msg, ...args) => {
    process.stderr.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: lvl,
      message: '[tomo-id-040] worst-pri-product/backend/telemetry.js: opentelemetry sdk diagnostic',
      otelMessage: String(msg),
      otelDetails: args.length ? args.map((a) => (a instanceof Error ? a.message : a)) : undefined,
      action: 'verify OTEL_EXPORTER_OTLP_ENDPOINT points at a running collector',
    }) + '\n');
  };
  diag.setLogger({ error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug'), verbose: write('debug') }, { logLevel: level, suppressOverrideMessage: true });
}

function start({ serviceName, attributes = {} } = {}) {
  if (sdk) return sdk;
  if (String(process.env.OTEL_SDK_DISABLED).toLowerCase() === 'true') return null;

  installDiagLogger();

  const exportIntervalMillis = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 10000);

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || serviceName,
    // Merged with auto-detected host/os/process/container + OTEL_RESOURCE_ATTRIBUTES.
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || serviceName,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
      'service.namespace': SERVICE_NAMESPACE,
      'deployment.environment.name': process.env.DEPLOYMENT_ENVIRONMENT || 'local',
      ...attributes,
    }),
    // Exporters read OTEL_EXPORTER_OTLP_(TRACES_|METRICS_|LOGS_)ENDPOINT / _HEADERS.
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis,
      exportTimeoutMillis: Math.min(exportIntervalMillis, 30000),
    })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [getNodeAutoInstrumentations({
      // HTTP server/client spans + http.server/client.request.duration metrics.
      '@opentelemetry/instrumentation-http': {
        ignoreIncomingRequestHook: (req) => req.url === '/favicon.ico',
      },
      // Keep route handler spans; drop the ~10 per-request middleware/router
      // spans (chaos latency has its own explicit `chaos.middleware` span).
      '@opentelemetry/instrumentation-express': {
        ignoreLayersType: ['middleware', 'router'],
      },
      // Event loop delay/utilization, GC, heap — on by default, made explicit.
      '@opentelemetry/instrumentation-runtime-node': { enabled: true },
      // process/system CPU, memory, network.
      '@opentelemetry/instrumentation-host-metrics': { enabled: true },
      // Too noisy for this app: a span per DNS lookup / socket / file read.
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-fs': { enabled: false },
    })],
  });

  sdk.start();
  return sdk;
}

/**
 * Flush everything buffered and stop exporting. Safe to call more than once.
 * Bounded so a dead collector can never block process exit.
 */
function shutdown(timeoutMs = 5000) {
  if (!sdk) return Promise.resolve();
  if (!shutdownPromise) {
    shutdownPromise = Promise.race([
      sdk.shutdown(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]).catch((err) => {
      process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', message: '[tomo-id-041] worst-pri-product/backend/telemetry.js: telemetry flush failed during shutdown', errorType: err.name, errorMessage: err.message, action: 'some buffered spans/metrics/logs may be lost; check collector availability' }) + '\n');
    });
  }
  return shutdownPromise;
}

module.exports = { start, shutdown, SERVICE_VERSION };
