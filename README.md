# OpenAN Observability SDK for TypeScript

English | [简体中文](README.zh-CN.md)

The OpenAN Observability SDK records A2A/A2A-T, Workflow, and Agent traces, metrics, and logs. It validates signal names and attributes, maps them to OpenTelemetry data, and exports telemetry to an OpenTelemetry Collector over OTLP.

## Signal coverage

| Category | Traces | Metrics | Logs |
|---|---|---|---|
| A2A / A2A-T | A2A messages, tasks, and streaming calls; Task-T, Negotiation-T, Notification-T, and Authorization-T | A2A operation and streaming metrics; eight A2A-T metrics | A2A-T message events |
| Workflow | Workflow and step spans | Workflow duration/count and step duration | Workflow and step events |
| Agent | Agent substep spans | Substep duration and token usage | Agent lifecycle and substep events |

Signal definitions ship with the SDK in [src/config](src/config). The A2A configuration version is 1.0.0.

## Requirements and install

- Node.js 22.15 or later
- OTLP Collector accepting gRPC on port 4317 or HTTP/protobuf on port 4318

<pre><code>npm install openan-observability-sdk</code></pre>

## Quick start

<pre><code>import { LogSeverity, ObservabilitySdk, SignalKind } from "openan-observability-sdk";

const sdk = ObservabilitySdk.start({
  serviceName: "diagnosis-agent",
  endpoint: "http://localhost:4317",
  protocol: "grpc",
});

const observe = sdk.observe();
const task = { "extension.name": "task-t", "task.type": "diagnosis" };

const span = observe.trace("SendMessage", SignalKind.CLIENT, task);
await span.makeCurrent(async () =&gt; {
  observe.log("gen_ai.agent.a2at.message", LogSeverity.INFO, "diagnosis completed", task, { span });
  observe.metric("task.duration", 42_000, { "task.type": "diagnosis" });
  observe.metric("task.count", 1, { "task.type": "diagnosis" });
  span.ok();
});
span.end();

if (!(await sdk.flush())) {
  throw new Error("OTLP flush failed or timed out");
}
await sdk.close();</code></pre>

ObservationSpan.makeCurrent(callback) runs synchronous or asynchronous work with the span active in OpenTelemetry context. ObservationSpan.error(error) records an exception and marks the span as failed.

## Workflow and agent signals

<pre><code>import { LogSeverity, ObservabilitySdk, SignalKind } from "openan-observability-sdk";

const sdk = ObservabilitySdk.start();
const observe = sdk.observe();
const workflow = {
  "workflow.id": "wf-001",
  "workflow.type": "fault-diagnosis",
  "workflow.status": "running",
};
const span = observe.trace("a2at.workflow", SignalKind.INTERNAL, workflow);
await span.makeCurrent(async () =&gt; {
  observe.metric("workflow.duration", 42, {
    "workflow.type": "fault-diagnosis",
    "workflow.status": "completed",
  });
  observe.log("gen_ai.agent.a2at.workflow", LogSeverity.INFO, "workflow completed", {
    ...workflow,
    "workflow.status": "completed",
  });
  span.ok();
});
span.end();
await sdk.close();</code></pre>

## Trace context propagation

Use TraceContextPropagation.inject and runWithExtracted with HTTP headers or another text carrier:

<pre><code>import { ObservabilitySdk, SignalKind, TraceContextPropagation } from "openan-observability-sdk";

const sdk = ObservabilitySdk.start();
const observe = sdk.observe();
const headers: Record&lt;string, string&gt; = {};

const client = observe.trace("SendMessage", SignalKind.CLIENT, { "operation.name": "SendMessage" });
await client.makeCurrent(() =&gt; TraceContextPropagation.inject(headers));
client.end();

await TraceContextPropagation.runWithExtracted(headers, async () =&gt; {
  const server = observe.trace("SendMessage", SignalKind.SERVER, { "operation.name": "SendMessage" });
  server.ok();
  server.end();
});
await sdk.close();</code></pre>

## OTLP configuration

Durations in the TypeScript API use milliseconds. Explicit SdkConfig fields take precedence over supported environment variables.

| Field | Environment variable | Default |
|---|---|---|
| endpoint | OTEL_EXPORTER_OTLP_ENDPOINT | gRPC: http://localhost:4317; HTTP/protobuf: http://localhost:4318 |
| protocol | OTEL_EXPORTER_OTLP_PROTOCOL | grpc; also supports http/protobuf |
| serviceName | OTEL_SERVICE_NAME | unknown_service |
| metricIntervalMillis | OTEL_METRIC_EXPORT_INTERVAL | 60000 |
| headers | OTEL_EXPORTER_OTLP_HEADERS | no request headers |
| trustedCertificate | OTEL_EXPORTER_OTLP_CERTIFICATE | system trust store |
| clientCertificate + clientPrivateKey | — | none |
| exportTimeoutMillis | OTEL_EXPORTER_OTLP_TIMEOUT | 10000 |
| enabled | — | true |
| spanBatch | — | queue 2048, batch 512, delay 5000 ms |
| logBatch | — | queue 2048, batch 512, delay 1000 ms |

For HTTP/protobuf, provide the Collector base URL; the SDK appends /v1/traces, /v1/metrics, and /v1/logs. Mutual TLS requires both client certificate and private key. Custom trust or client certificates require an HTTPS endpoint. Environment header values must be percent-encoded; values passed through SdkConfig.headers are raw.

Use sdk.setEnabled(false) to stop new SDK records at runtime. sdk.updateExporters(config) replaces OTLP exporters when service name, metric interval, and batch settings match the active providers.

See the [API reference](doc/en/api-reference.md) and [development guide](doc/en/development-guide.md) for public API details and signal-definition maintenance.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
