# API reference

## Start and manage the SDK

`ObservabilitySdk.start(config?)` resolves explicit options and the supported OpenTelemetry environment variables, creates trace, metric, and log providers, and returns an SDK instance. Node.js 22.15 or later is required by the OpenTelemetry packages used by this release.

`sdk.observe()` returns the `Observability` facade. `sdk.setEnabled(false)` stops new SDK records while leaving providers available for flushing. `sdk.flush(timeoutMillis?)` and `sdk.forceFlush(timeoutMillis?)` flush all providers and return `true` when the flush completed without a new exporter failure. `sdk.close()` asynchronously flushes and shuts down providers; repeated calls return the same shutdown operation.

`sdk.updateExporters(config)` changes OTLP endpoints, protocol, headers, timeout, and TLS credentials at runtime. The service name, metric export interval, and trace/log batch settings must match the active providers. The replacement exporter set is prepared before switching, and in-flight exports finish before old exporters are shut down.

## Configuration

Pass `SdkConfigOptions` to `ObservabilitySdk.start` or construct `new SdkConfig(options)`. Durations are milliseconds.

| Option | Default | Notes |
|---|---|---|
| `endpoint` | protocol-dependent | Collector base URL. HTTP/protobuf adds `/v1/traces`, `/v1/metrics`, and `/v1/logs`. |
| `protocol` | `grpc` | Supports `grpc` and `http/protobuf`. |
| `serviceName` | `unknown_service` | Sets resource attribute `service.name`. |
| `metricIntervalMillis` | `60000` | Periodic metric export interval. |
| `exportTimeoutMillis` | `10000` | OTLP request timeout; `0` disables the deadline. |
| `headers` | environment headers or empty | Header values are raw strings. Names are normalized to lowercase. |
| `trustedCertificate` | system trust store | PEM CA file for HTTPS Collector TLS. |
| `clientCertificate`, `clientPrivateKey` | unset | PEM pair for mutual TLS. |
| `enabled` | `true` | Initial recording state. |
| `spanBatch`, `logBatch` | queue `2048`, batch `512` | Each accepts `maxQueueSize`, `maxExportBatchSize`, `scheduleDelayMillis`, `exportTimeoutMillis`. |

Supported environment variables are `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_CERTIFICATE`, `OTEL_METRIC_EXPORT_INTERVAL`, and `OTEL_SERVICE_NAME`. Explicit values take precedence. Header values in `OTEL_EXPORTER_OTLP_HEADERS` use percent encoding.

## Record signals

`observe.trace(name, kind, attributes?, parent?)` starts a configured span and returns an `ObservationSpan`. Invalid or unsupported spans produce an invalid no-op handle and a value-free warning. `ObservationSpan` provides `attributes`, `ok`, `error(error?)`, `makeCurrent(callback)`, `close`, and `end`.

`observe.metric(metricId, value, attributes?)` records a configured counter or histogram sample. Values must be finite and non-negative. Integer attributes and counters must be safe JavaScript integers.

`observe.log(name, severity, body, attributes?, { span?, context? }?)` emits a structured log. The severity can be one of `LogSeverity.TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, or `FATAL`. Pass at most one span or explicit OpenTelemetry context.

`observe.logRecord(severity, body, attributes?, { eventName?, timestamp?, exception?, context? }?)` emits a general OpenTelemetry log without a configured signal schema. The timestamp is a JavaScript `Date`; attributes may contain strings, booleans, finite numbers, or string arrays. String values and the exception message are sanitized before export.

A2A trace names use JSON-RPC method names such as `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `ListTasks`, and push-notification configuration methods. `GetExtendedAgentCard` and `SendPushNotification` are client-only; `SendStreamingMessage-negotiation` is server-only. Stream events may include task status and artifact attributes, and message spans may include transport, protocol version, model, and token usage.

Signal names, attribute types, requirements, and metric dimensions come from the bundled YAML files in `src/config`. String values are redacted for common credentials and URL query/user information before export.

## Trace context propagation

`TraceContextPropagation.inject(carrier, setter?)` writes W3C `traceparent` and `tracestate` fields using the active context. `extract(carrier, getter?)` returns an extracted OpenTelemetry context. Use `runWithExtracted(carrier, callback, getter?)` to execute synchronous or asynchronous work in that context. `extractToCurrent(carrier, getter?)` is also available and returns a disposable scope; prefer the callback helper for async work.
