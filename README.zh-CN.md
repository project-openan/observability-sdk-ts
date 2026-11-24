# OpenAN TypeScript 可观测性 SDK

[English](README.md) | 简体中文

OpenAN TypeScript 可观测性 SDK 用于记录 A2A/A2A-T、Workflow 和 Agent 的 Trace、Metric 与 Log。SDK 会校验信号名称和属性，将其映射为 OpenTelemetry 数据，并通过 OTLP 导出到 OpenTelemetry Collector。

## 信号范围

| 类别 | Traces | Metrics | Logs |
|---|---|---|---|
| A2A / A2A-T | A2A 消息、任务和流式调用；Task-T、Negotiation-T、Notification-T、Authorization-T | A2A 操作及流式指标；八项 A2A-T 指标 | A2A-T 消息事件 |
| Workflow | Workflow 和 Step Span | Workflow 时长/计数和 Step 时长 | Workflow 和 Step 事件 |
| Agent | Agent Substep Span | Substep 时长和 Token 用量 | Agent 生命周期和 Substep 事件 |

信号定义随包发布在 [src/config](src/config) 中。A2A 配置版本为 1.0.0。

## 环境与安装

- Node.js 22.15 或更高版本
- OTLP Collector：gRPC 端口 4317，HTTP/protobuf 端口 4318

<pre><code>npm install openan-observability-sdk</code></pre>

## 快速开始

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
  observe.log("gen_ai.agent.a2at.message", LogSeverity.INFO, "诊断完成", task, { span });
  observe.metric("task.duration", 42_000, { "task.type": "diagnosis" });
  observe.metric("task.count", 1, { "task.type": "diagnosis" });
  span.ok();
});
span.end();
await sdk.close();</code></pre>

ObservationSpan.makeCurrent(callback) 会在 OpenTelemetry 当前上下文中执行同步或异步任务。ObservationSpan.error(error) 会记录异常并标记 Span 失败。

## Trace 上下文传播

TraceContextPropagation.inject 和 runWithExtracted 可用于 HTTP Header 等文本载体：

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

## OTLP 配置

TypeScript API 中的时长单位均为毫秒。显式的 SdkConfig 字段优先于支持的环境变量。

| 字段 | 环境变量 | 默认值 |
|---|---|---|
| endpoint | OTEL_EXPORTER_OTLP_ENDPOINT | gRPC：http://localhost:4317；HTTP/protobuf：http://localhost:4318 |
| protocol | OTEL_EXPORTER_OTLP_PROTOCOL | grpc，也支持 http/protobuf |
| serviceName | OTEL_SERVICE_NAME | unknown_service |
| metricIntervalMillis | OTEL_METRIC_EXPORT_INTERVAL | 60000 |
| headers | OTEL_EXPORTER_OTLP_HEADERS | 无请求 Header |
| trustedCertificate | OTEL_EXPORTER_OTLP_CERTIFICATE | 系统信任库 |
| clientCertificate + clientPrivateKey | — | 无 |
| exportTimeoutMillis | OTEL_EXPORTER_OTLP_TIMEOUT | 10000 |
| enabled | — | true |
| spanBatch | — | 队列 2048、批次 512、延迟 5000 毫秒 |
| logBatch | — | 队列 2048、批次 512、延迟 1000 毫秒 |

HTTP/protobuf 请提供 Collector 基础 URL，SDK 会补上 /v1/traces、/v1/metrics 和 /v1/logs。双向 TLS 需要同时设置客户端证书和私钥。自定义信任证书或客户端证书要求使用 HTTPS。环境变量中的 Header 值需要百分号编码；直接传给 SdkConfig.headers 的值无需编码。

运行中调用 sdk.setEnabled(false) 可暂停 SDK 新建记录。sdk.updateExporters(config) 可替换 OTLP Exporter，但服务名、Metric 导出间隔和批处理参数必须与当前 Provider 一致。

完整 API 和信号定义维护方式见[API 参考](doc/zh/API参考.md)和[开发指南](doc/zh/开发指南.md)。

## 许可证

Apache License 2.0。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
