# API 参考

## 启动和管理 SDK

`ObservabilitySdk.start(config?)` 会读取显式配置和支持的 OpenTelemetry 环境变量，创建 Trace、Metric、Log Provider 并返回 SDK 实例。当前依赖要求 Node.js 22.15 或更高版本。

`sdk.observe()` 返回 `Observability` 门面。`sdk.setEnabled(false)` 会停止 SDK 新建记录，但 Provider 仍可执行 flush。`sdk.flush(timeoutMillis?)` 和 `sdk.forceFlush(timeoutMillis?)` 刷新所有 Provider；当刷新完成且没有新增导出失败时返回 `true`。`sdk.close()` 异步刷新并关闭 Provider，重复调用会返回同一个关闭操作。

`sdk.updateExporters(config)` 可在运行时更新 OTLP Endpoint、协议、Header、超时和 TLS 凭据。服务名、Metric 导出间隔以及 Trace/Log 批处理参数必须与当前 Provider 相同。SDK 会先创建新的 Exporter 组，再切换并等待旧 Exporter 上的在途请求完成。

## 配置

`ObservabilitySdk.start` 接受 `SdkConfigOptions`，也可传入 `new SdkConfig(options)`。配置中的时长单位为毫秒。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `endpoint` | 随协议选择 | Collector 基础 URL。HTTP/protobuf 会补上 `/v1/traces`、`/v1/metrics` 和 `/v1/logs`。 |
| `protocol` | `grpc` | 支持 `grpc` 和 `http/protobuf`。 |
| `serviceName` | `unknown_service` | 设置资源属性 `service.name`。 |
| `metricIntervalMillis` | `60000` | Metric 周期导出间隔。 |
| `exportTimeoutMillis` | `10000` | OTLP 请求超时；`0` 表示不设置截止时间。 |
| `headers` | 环境变量或空 | Header 值按原样传递，名称会转换成小写。 |
| `trustedCertificate` | 系统信任库 | 用于 HTTPS Collector TLS 校验的 PEM CA 文件。 |
| `clientCertificate`、`clientPrivateKey` | 未设置 | 双向 TLS 的 PEM 客户端证书和私钥。 |
| `enabled` | `true` | 初始记录状态。 |
| `spanBatch`、`logBatch` | 队列 `2048`、批次 `512` | 支持 `maxQueueSize`、`maxExportBatchSize`、`scheduleDelayMillis`、`exportTimeoutMillis`。 |

支持的环境变量：`OTEL_EXPORTER_OTLP_PROTOCOL`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_EXPORTER_OTLP_TIMEOUT`、`OTEL_EXPORTER_OTLP_CERTIFICATE`、`OTEL_METRIC_EXPORT_INTERVAL` 和 `OTEL_SERVICE_NAME`。显式配置优先。`OTEL_EXPORTER_OTLP_HEADERS` 中的 Header 值需使用百分号编码。

## 记录信号

`observe.trace(name, kind, attributes?, parent?)` 启动已配置的 Span，并返回 `ObservationSpan`。遇到无效或不支持的 Span 时会返回无效 no-op 句柄并输出不含属性值的告警。`ObservationSpan` 提供 `attributes`、`ok`、`error(error?)`、`makeCurrent(callback)`、`close` 和 `end`。

`observe.metric(metricId, value, attributes?)` 记录配置的 Counter 或 Histogram 样本。数值必须有限且非负；整数属性和 Counter 值必须是 JavaScript 安全整数。

`observe.log(name, severity, body, attributes?, { span?, context? }?)` 发送结构化 Log。Severity 可选 `LogSeverity.TRACE`、`DEBUG`、`INFO`、`WARN`、`ERROR` 或 `FATAL`。Span 与显式 OpenTelemetry Context 最多传入一个。

`observe.logRecord(severity, body, attributes?, { eventName?, timestamp?, exception?, context? }?)` 发送不使用预定义信号 Schema 的通用 OpenTelemetry Log。时间戳使用 JavaScript `Date`；属性支持字符串、布尔值、有限数值和字符串数组。导出前会清理字符串属性和异常信息。

A2A Trace 名称使用 JSON-RPC 方法名，例如 `SendMessage`、`SendStreamingMessage`、`GetTask`、`CancelTask`、`ListTasks` 和推送通知配置方法。`GetExtendedAgentCard` 与 `SendPushNotification` 仅支持 Client；`SendStreamingMessage-negotiation` 仅支持 Server。流事件可记录任务状态和 Artifact 属性，消息 Span 可记录传输方式、协议版本、模型及 Token 用量。

支持的信号名称、属性类型、必填字段和 Metric 维度由 `src/config` 中的 YAML 文件定义。导出前会对常见凭据和 URL 查询信息进行脱敏。

## Trace 上下文传播

`TraceContextPropagation.inject(carrier, setter?)` 会把当前上下文中的 W3C `traceparent` 和 `tracestate` 写入载体。`extract(carrier, getter?)` 返回提取后的 OpenTelemetry Context。使用 `runWithExtracted(carrier, callback, getter?)` 可在该上下文中执行同步或异步操作。`extractToCurrent(carrier, getter?)` 也可用，并返回可释放作用域；异步操作优先使用回调形式。
