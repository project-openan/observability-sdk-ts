/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 *    Licensed under the Apache License, Version 2.0 (the License); you may
 *    not use this file except in compliance with the License. You may obtain
 *    a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an AS IS BASIS, WITHOUT
 *    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 *    License for the specific language governing permissions and limitations
 *    under the License.
 */

import { credentials, Metadata } from "@grpc/grpc-js";
import { context } from "@opentelemetry/api";
import { OTLPLogExporter as GrpcLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as HttpLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as HttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationType,
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
  type InstrumentType,
} from "@opentelemetry/sdk-metrics";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { SdkConfig, type ResolvedSdkConfig, type SdkConfigOptions } from "./config.js";
import { Observability } from "./observability.js";

interface ExporterSet {
  traces: SpanExporter;
  metrics: PushMetricExporter;
  logs: LogRecordExporter;
}

interface ShutdownExporter {
  shutdown(): Promise<void> | void;
}

class ExportFailures {
  count = 0;
  increment(): void { this.count += 1; }
}

class ExporterHolder<T extends ShutdownExporter> {
  private activeExports = 0;
  private retired = false;
  private shutdownStarted = false;
  private completion?: Promise<void>;
  private resolveCompletion?: () => void;
  private rejectCompletion?: (error: unknown) => void;

  constructor(readonly exporter: T) {}

  acquire(): T {
    this.activeExports += 1;
    return this.exporter;
  }

  release(): void {
    this.activeExports = Math.max(0, this.activeExports - 1);
    this.shutdownWhenReady();
  }

  retire(): Promise<void> {
    if (!this.completion) {
      this.completion = new Promise<void>((resolve, reject) => {
        this.resolveCompletion = resolve;
        this.rejectCompletion = reject;
      });
      this.retired = true;
    }
    this.shutdownWhenReady();
    return this.completion;
  }

  private shutdownWhenReady(): void {
    if (!this.retired || this.activeExports !== 0 || this.shutdownStarted) return;
    this.shutdownStarted = true;
    try {
      Promise.resolve(this.exporter.shutdown()).then(
        () => this.resolveCompletion?.(),
        (error: unknown) => this.rejectCompletion?.(error),
      );
    } catch (error) {
      this.rejectCompletion?.(error);
    }
  }
}

class SwitchingSpanExporter implements SpanExporter {
  private holder: ExporterHolder<SpanExporter>;
  constructor(initial: SpanExporter, private readonly failures: ExportFailures) {
    this.holder = new ExporterHolder(initial);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.exportWith((exporter, callback) => exporter.export(spans, callback), resultCallback);
  }

  forceFlush(): Promise<void> {
    const exporter = this.holder.exporter;
    return exporter.forceFlush ? exporter.forceFlush() : Promise.resolve();
  }

  shutdown(): Promise<void> { return this.holder.retire(); }

  replace(exporter: SpanExporter): Promise<void> {
    const previous = this.holder;
    this.holder = new ExporterHolder(exporter);
    return previous.retire();
  }

  private exportWith(
    operation: (exporter: SpanExporter, callback: (result: ExportResult) => void) => void,
    resultCallback: (result: ExportResult) => void,
  ): void {
    const holder = this.holder;
    const exporter = holder.acquire();
    let finished = false;
    const finish = (result: ExportResult): void => {
      if (finished) return;
      finished = true;
      if (result.code !== ExportResultCode.SUCCESS) this.failures.increment();
      holder.release();
      resultCallback(result);
    };
    try {
      operation(exporter, finish);
    } catch (error) {
      finish({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error("OTLP trace export failed") });
    }
  }
}

class SwitchingMetricExporter implements PushMetricExporter {
  private holder: ExporterHolder<PushMetricExporter>;
  constructor(initial: PushMetricExporter, private readonly failures: ExportFailures) {
    this.holder = new ExporterHolder(initial);
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    const holder = this.holder;
    const exporter = holder.acquire();
    let finished = false;
    const finish = (result: ExportResult): void => {
      if (finished) return;
      finished = true;
      if (result.code !== ExportResultCode.SUCCESS) this.failures.increment();
      holder.release();
      resultCallback(result);
    };
    try {
      exporter.export(metrics, finish);
    } catch (error) {
      finish({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error("OTLP metric export failed") });
    }
  }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    const exporter = this.holder.exporter;
    return exporter.selectAggregationTemporality?.(instrumentType) ?? AggregationTemporality.CUMULATIVE;
  }

  selectAggregation(instrumentType: InstrumentType) {
    return this.holder.exporter.selectAggregation?.(instrumentType) ?? { type: AggregationType.DEFAULT };
  }

  forceFlush(): Promise<void> {
    const exporter = this.holder.exporter;
    return exporter.forceFlush ? exporter.forceFlush() : Promise.resolve();
  }

  shutdown(): Promise<void> { return this.holder.retire(); }

  replace(exporter: PushMetricExporter): Promise<void> {
    const previous = this.holder;
    this.holder = new ExporterHolder(exporter);
    return previous.retire();
  }
}

class SwitchingLogExporter implements LogRecordExporter {
  private holder: ExporterHolder<LogRecordExporter>;
  constructor(initial: LogRecordExporter, private readonly failures: ExportFailures) {
    this.holder = new ExporterHolder(initial);
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    const holder = this.holder;
    const exporter = holder.acquire();
    let finished = false;
    const finish = (result: ExportResult): void => {
      if (finished) return;
      finished = true;
      if (result.code !== ExportResultCode.SUCCESS) this.failures.increment();
      holder.release();
      resultCallback(result);
    };
    try {
      exporter.export(logs, finish);
    } catch (error) {
      finish({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error("OTLP log export failed") });
    }
  }

  forceFlush(): Promise<void> {
    const exporter = this.holder.exporter;
    return exporter.forceFlush ? exporter.forceFlush() : Promise.resolve();
  }

  shutdown(): Promise<void> { return this.holder.retire(); }

  replace(exporter: LogRecordExporter): Promise<void> {
    const previous = this.holder;
    this.holder = new ExporterHolder(exporter);
    return previous.retire();
  }
}

/** Owns the trace, metric, and log providers used by this SDK. */
export class ObservabilitySdk {
  private static contextManagerInstalled = false;
  private readonly traceProvider: TracerProvider;
  private readonly meterProvider: MeterProvider;
  private readonly loggerProvider: LoggerProvider;
  private readonly spanExporter: SwitchingSpanExporter;
  private readonly metricExporter: SwitchingMetricExporter;
  private readonly logExporter: SwitchingLogExporter;
  private readonly failures = new ExportFailures();
  private reportedFailures = 0;
  private enabledState: boolean;
  private providerConfig: ResolvedSdkConfig;
  private closed = false;
  private closePromise?: Promise<void>;
  private reconfiguring = false;

  private constructor(config: ResolvedSdkConfig, exporters: ExporterSet) {
    this.providerConfig = config;
    this.enabledState = config.enabled;
    this.spanExporter = new SwitchingSpanExporter(exporters.traces, this.failures);
    this.metricExporter = new SwitchingMetricExporter(exporters.metrics, this.failures);
    this.logExporter = new SwitchingLogExporter(exporters.logs, this.failures);
    const resource = defaultResource().merge(resourceFromAttributes({ "service.name": config.serviceName }));
    this.traceProvider = new TracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor({
        exporter: this.spanExporter,
        maxQueueSize: config.spanBatch.maxQueueSize,
        maxExportBatchSize: config.spanBatch.maxExportBatchSize,
        scheduledDelayMillis: config.spanBatch.scheduleDelayMillis,
        exportTimeoutMillis: config.spanBatch.exportTimeoutMillis,
      })],
    });
    const metricReader = new PeriodicExportingMetricReader({
      exporter: this.metricExporter,
      exportIntervalMillis: config.metricIntervalMillis,
      exportTimeoutMillis: config.exportTimeoutMillis,
    });
    this.meterProvider = new MeterProvider({ resource, readers: [metricReader] });
    this.loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor({
        exporter: this.logExporter,
        maxQueueSize: config.logBatch.maxQueueSize,
        maxExportBatchSize: config.logBatch.maxExportBatchSize,
        scheduledDelayMillis: config.logBatch.scheduleDelayMillis,
        exportTimeoutMillis: config.logBatch.exportTimeoutMillis,
      })],
    });
    this.observability = new Observability(
      this.traceProvider.getTracer("openan-observability-sdk"),
      this.meterProvider.getMeter("openan-observability-sdk"),
      this.loggerProvider.getLogger("openan-observability-sdk"),
      () => this.enabledState && !this.closed,
    );
  }

  private readonly observability: Observability;

  static start(config: SdkConfig | SdkConfigOptions = {}): ObservabilitySdk {
    const resolved = (config instanceof SdkConfig ? config : new SdkConfig(config)).resolve();
    this.installContextManager();
    const exporters = createExporters(resolved);
    try {
      return new ObservabilitySdk(resolved, exporters);
    } catch (error) {
      shutdownExporters([exporters.traces, exporters.metrics, exporters.logs]);
      throw error;
    }
  }

  observe(): Observability { return this.observability; }

  setEnabled(value: boolean): void {
    if (typeof value !== "boolean") throw new TypeError("enabled must be a boolean");
    if (this.closed) return;
    this.enabledState = value;
  }

  isEnabled(): boolean { return this.enabledState && !this.closed; }

  async forceFlush(timeoutMillis = 30_000): Promise<boolean> {
    if (!Number.isFinite(timeoutMillis) || timeoutMillis < 0) throw new TypeError("timeoutMillis must be non-negative");
    const failuresBefore = this.reportedFailures;
    const results = await Promise.allSettled([
      this.traceProvider.forceFlush({ timeoutMillis }),
      this.meterProvider.forceFlush({ timeoutMillis }),
      this.loggerProvider.forceFlush({ timeoutMillis }),
    ]);
    const failedExports = this.failures.count;
    this.reportedFailures = failedExports;
    return results.every((result) => result.status === "fulfilled") && failedExports === failuresBefore;
  }

  flush(timeoutMillis = 30_000): Promise<boolean> {
    return this.forceFlush(timeoutMillis);
  }

  async updateExporters(config: SdkConfig | SdkConfigOptions): Promise<boolean> {
    if (this.closed || this.reconfiguring) return false;
    this.reconfiguring = true;
    let replacement: ExporterSet | undefined;
    try {
      const resolved = (config instanceof SdkConfig ? config : new SdkConfig(config)).resolve();
      if (!sameProviderSettings(this.providerConfig, resolved)) return false;
      replacement = createExporters(resolved);
      if (!(await this.forceFlush(resolved.exportTimeoutMillis))) {
        await shutdownExporters([replacement.traces, replacement.metrics, replacement.logs]);
        return false;
      }
      const retired = await Promise.allSettled([
        this.spanExporter.replace(replacement.traces),
        this.metricExporter.replace(replacement.metrics),
        this.logExporter.replace(replacement.logs),
      ]);
      replacement = undefined;
      this.providerConfig = resolved;
      if (resolved.enabled !== this.enabledState) this.enabledState = resolved.enabled;
      return retired.every((result) => result.status === "fulfilled");
    } catch {
      if (replacement) await shutdownExporters([replacement.traces, replacement.metrics, replacement.logs]);
      return false;
    } finally {
      this.reconfiguring = false;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.enabledState = false;
    this.closePromise = Promise.allSettled([
      this.traceProvider.shutdown(),
      this.meterProvider.shutdown(),
      this.loggerProvider.shutdown(),
    ]).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.closePromise;
  }

  private static installContextManager(): void {
    if (this.contextManagerInstalled) return;
    const manager = new AsyncLocalStorageContextManager();
    if (context.setGlobalContextManager(manager)) {
      manager.enable();
      this.contextManagerInstalled = true;
    } else {
      manager.disable();
      this.contextManagerInstalled = true;
    }
  }
}

function createExporters(config: ResolvedSdkConfig): ExporterSet {
  const created: ShutdownExporter[] = [];
  const headers = Object.entries(config.headers);
  const certificate = config.protocol === "grpc" && config.endpoint.startsWith("https:")
    ? credentials.createSsl(config.trustedCertificateData, config.clientPrivateKeyData, config.clientCertificateData)
    : undefined;
  const metadata = headers.length > 0 ? new Metadata() : undefined;
  for (const [name, value] of headers) metadata?.set(name, value);
  const grpcOptions = {
    url: config.endpoint,
    ...(certificate ? { credentials: certificate } : {}),
    ...(metadata ? { metadata } : {}),
    timeoutMillis: config.exportTimeoutMillis,
  };
  const httpBase = config.endpoint.replace(/\/+$/, "");
  const httpOptions = {
    headers: { ...config.headers },
    timeoutMillis: config.exportTimeoutMillis,
    ...(config.endpoint.startsWith("https:") && (config.trustedCertificateData || config.clientCertificateData)
      ? { httpAgentOptions: {
          ...(config.trustedCertificateData ? { ca: config.trustedCertificateData } : {}),
          ...(config.clientCertificateData ? { cert: config.clientCertificateData } : {}),
          ...(config.clientPrivateKeyData ? { key: config.clientPrivateKeyData } : {}),
        } }
      : {}),
  };
  try {
    if (config.protocol === "grpc") {
      const traces = new GrpcTraceExporter(grpcOptions);
      created.push(traces);
      const metrics = new GrpcMetricExporter(grpcOptions);
      created.push(metrics);
      const logs = new GrpcLogExporter(grpcOptions);
      created.push(logs);
      return { traces, metrics, logs };
    }
    const traces = new HttpTraceExporter({ ...httpOptions, url: `${httpBase}/v1/traces` });
    created.push(traces);
    const metrics = new HttpMetricExporter({ ...httpOptions, url: `${httpBase}/v1/metrics` });
    created.push(metrics);
    const logs = new HttpLogExporter({ ...httpOptions, url: `${httpBase}/v1/logs` });
    created.push(logs);
    return { traces, metrics, logs };
  } catch (error) {
    void shutdownExporters(created);
    throw error;
  }
}

async function shutdownExporters(exporters: ShutdownExporter[]): Promise<void> {
  await Promise.allSettled(exporters.map((exporter) => Promise.resolve().then(() => exporter.shutdown())));
}

function sameProviderSettings(left: ResolvedSdkConfig, right: ResolvedSdkConfig): boolean {
  return left.serviceName === right.serviceName &&
    left.metricIntervalMillis === right.metricIntervalMillis &&
    sameBatch(left.spanBatch, right.spanBatch) &&
    sameBatch(left.logBatch, right.logBatch);
}

function sameBatch(left: ResolvedSdkConfig["spanBatch"], right: ResolvedSdkConfig["spanBatch"]): boolean {
  return left.maxQueueSize === right.maxQueueSize &&
    left.maxExportBatchSize === right.maxExportBatchSize &&
    left.scheduleDelayMillis === right.scheduleDelayMillis &&
    left.exportTimeoutMillis === right.exportTimeoutMillis;
}
