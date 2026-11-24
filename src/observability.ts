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

import {
  context,
  ROOT_CONTEXT,
  SeverityNumber,
  SpanKind,
  trace,
  type Context,
  type Logger,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";
import type { AttributeValue, SpanAttributes } from "@opentelemetry/api";
import { clean, convertGeneralLogAttributes, metricShortName, selectExtension, validateAttributes } from "./_attributes.js";
import { SIGNAL_CATALOG, type MetricDefinition, type SignalCatalog, type SignalDefinition } from "./definitions.js";
import { LogSeverity, SignalKind } from "./enums.js";
import { ObservationSpan } from "./span.js";

const DIAGNOSTICS = { warn: (message: string) => console.warn(message) };

export class Observability {
  private readonly histograms = new Map<string, ReturnType<Meter["createHistogram"]>>();
  private readonly counters = new Map<string, ReturnType<Meter["createCounter"]>>();

  constructor(
    private readonly tracer: Tracer,
    meter: Meter,
    private readonly logger: Logger,
    private readonly enabled: () => boolean,
    private readonly catalog: SignalCatalog = SIGNAL_CATALOG,
  ) {
    for (const definition of catalog.metrics.values()) {
      if (definition.histogram) {
        this.histograms.set(definition.name, meter.createHistogram(definition.name, { unit: definition.unit }));
      } else {
        this.counters.set(definition.name, meter.createCounter(definition.name, { unit: definition.unit }));
      }
    }
  }

  trace(
    name: string,
    kind: SignalKind | `${SpanKind}` | string,
    attributes: Readonly<Record<string, unknown>> = {},
    parent?: ObservationSpan,
  ): ObservationSpan {
    const currentContext = context.active();
    if (!this.enabled()) return new ObservationSpan(undefined, currentContext, undefined, this.catalog);
    try {
      if (typeof name !== "string" || !name) throw new TypeError("span name is required");
      if (parent !== undefined && !(parent instanceof ObservationSpan)) throw new TypeError("parent must be an ObservationSpan");
      const spanKind = spanKindFrom(kind);
      const isA2a = this.catalog.a2a.traceNames.has(name);
      const isStreamEvent = name === this.catalog.a2a.streamEvent || name === this.catalog.a2a.streamError;
      let definition: SignalDefinition | undefined;
      if (isA2a) {
        if (spanKind !== SpanKind.CLIENT && spanKind !== SpanKind.SERVER) throw new TypeError("A2A spans require CLIENT or SERVER kind");
        if (this.catalog.a2a.clientOnlyTraces.has(name) && spanKind !== SpanKind.CLIENT) throw new TypeError("A2A trace is client-only");
        if (this.catalog.a2a.serverOnlyTraces.has(name) && spanKind !== SpanKind.SERVER) throw new TypeError("A2A trace is server-only");
        const extension = selectExtension(attributes, this.catalog.spans, this.catalog);
        if (name === this.catalog.a2a.streamNegotiation) {
          definition = {
            ...(this.catalog.a2a.streamNegotiationSpan.extension
              ? { extension: this.catalog.a2a.streamNegotiationSpan.extension }
              : {}),
            allowed: new Set([...this.catalog.a2a.span.allowed, ...this.catalog.a2a.streamNegotiationSpan.allowed]),
            required: this.catalog.a2a.streamNegotiationSpan.required,
          };
        } else if (extension) {
          if (name !== this.catalog.a2a.message && name !== this.catalog.a2a.stream) throw new TypeError("A2A extension attributes are only supported on message traces");
          definition = {
            ...(extension.extension ? { extension: extension.extension } : {}),
            allowed: new Set([...this.catalog.a2a.span.allowed, ...extension.allowed]),
            required: extension.required,
          };
        } else {
          definition = name === this.catalog.a2a.streamEvent ? this.catalog.a2a.streamEventSpan : this.catalog.a2a.span;
        }
      } else {
        if (spanKind !== SpanKind.INTERNAL) throw new TypeError("Workflow and agent spans require INTERNAL kind");
        definition = this.catalog.namedTrace(name);
        if (!definition) throw new TypeError("unknown span name");
      }
      const converted = validateAttributes(attributes, "S", definition, this.catalog);
      const parentContext = parent?.context ?? currentContext;
      const links = isStreamEvent ? getStreamLinks(parent, currentContext) : [];
      const spanParentContext = isStreamEvent ? ROOT_CONTEXT : parentContext;
      const span = this.tracer.startSpan(name, {
        kind: spanKind,
        attributes: converted as SpanAttributes,
        ...(links.length ? { links } : {}),
      }, spanParentContext);
      const spanContext = trace.setSpan(isStreamEvent ? contextRoot : parentContext, span);
      return new ObservationSpan(span, spanContext, definition, this.catalog);
    } catch {
      DIAGNOSTICS.warn("Observation trace rejected");
      return new ObservationSpan(undefined, currentContext, undefined, this.catalog);
    }
  }

  metric(metricId: string, value: number, attributes: Readonly<Record<string, unknown>> = {}): void {
    if (!this.enabled()) return;
    try {
      if (typeof metricId !== "string" || !metricId) throw new TypeError("metric name is required");
      const definition = this.metricDefinition(metricId);
      if (!definition) throw new TypeError("unknown metric");
      if (metricId.startsWith("gen_ai.agent.a2at.") && definition.a2a) throw new TypeError("A2A metric names do not use the A2A-T prefix");
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("metric value must be finite and non-negative");
      if (definition.integer && !Number.isSafeInteger(value)) throw new TypeError("metric value must be a safe integer");

      const converted = validateAttributes(attributes, "M", undefined, this.catalog, { allowed: definition.allowed });
      const supplied = new Set<string>();
      for (const key of definition.allowed) {
        const declaredName = this.catalog.attributes.get(key)?.name;
        if (declaredName && Object.hasOwn(converted, declaredName)) supplied.add(key);
      }
      if ([...definition.required].some((key) => !supplied.has(key))) throw new TypeError("required metric dimension is missing");
      const metricAttributes = { ...converted } as Record<string, AttributeValue>;
      if (definition.a2a) metricAttributes["gen_ai.system"] = "a2a";
      if (definition.histogram) this.histograms.get(definition.name)?.record(value, metricAttributes);
      else this.counters.get(definition.name)?.add(value, metricAttributes);
    } catch {
      DIAGNOSTICS.warn("Observation metric rejected");
    }
  }

  log(
    name: string,
    severity: LogSeverity | `${LogSeverity}` | string,
    body: string,
    attributes: Readonly<Record<string, unknown>> = {},
    options: { span?: ObservationSpan; context?: Context } = {},
  ): void {
    if (!this.enabled()) return;
    try {
      if (typeof name !== "string" || !name || typeof body !== "string") throw new TypeError("log name and body are required");
      if (options.span && options.context) throw new TypeError("provide span or context, not both");
      const normalizedSeverity = String(severity).toUpperCase() as LogSeverity;
      const severityNumber = SEVERITY_NUMBERS[normalizedSeverity];
      if (severityNumber === undefined) throw new TypeError("unsupported log severity");
      let definition: SignalDefinition | undefined;
      if (name === "gen_ai.agent.a2at.message") {
        definition = selectExtension(attributes, this.catalog.logs, this.catalog);
        if (!definition) throw new TypeError("message logs require a supported extension");
      } else {
        definition = this.catalog.namedLog(name);
        if (!definition) throw new TypeError("unknown log name");
      }
      const converted = validateAttributes(attributes, "L", definition, this.catalog);
      const logContext = options.span?.context ?? options.context;
      this.logger.emit({
        eventName: name,
        severityNumber,
        severityText: normalizedSeverity,
        body: clean(body),
        attributes: converted,
        ...(logContext ? { context: logContext } : {}),
      });
    } catch {
      DIAGNOSTICS.warn("Observation log rejected");
    }
  }

  logRecord(
    severity: LogSeverity | `${LogSeverity}` | string,
    body: string,
    attributes: Readonly<Record<string, unknown>> = {},
    options: { eventName?: string; timestamp?: Date; exception?: Error; context?: Context } = {},
  ): void {
    if (!this.enabled()) return;
    try {
      if (typeof body !== "string") throw new TypeError("log body is required");
      if (options.eventName !== undefined && typeof options.eventName !== "string") throw new TypeError("event name must be a string");
      if (options.timestamp !== undefined && (!(options.timestamp instanceof Date) || Number.isNaN(options.timestamp.valueOf()))) {
        throw new TypeError("timestamp must be a valid Date");
      }
      if (options.exception !== undefined && !(options.exception instanceof Error)) throw new TypeError("exception must be an Error");
      const normalizedSeverity = String(severity).toUpperCase() as LogSeverity;
      const severityNumber = SEVERITY_NUMBERS[normalizedSeverity];
      if (severityNumber === undefined) throw new TypeError("unsupported log severity");
      const converted = convertGeneralLogAttributes(attributes) as Record<string, AttributeValue>;
      if (options.exception) {
        converted["exception.type"] = options.exception.constructor.name;
        converted["exception.message"] = clean(options.exception.toString());
      }
      this.logger.emit({
        ...(options.eventName?.trim() ? { eventName: clean(options.eventName) } : {}),
        ...(options.timestamp ? { timestamp: options.timestamp } : {}),
        severityNumber,
        severityText: normalizedSeverity,
        body: clean(body),
        attributes: converted,
        context: options.context ?? context.active(),
      });
    } catch {
      DIAGNOSTICS.warn("Observation general log rejected");
    }
  }

  private metricDefinition(metricId: string): MetricDefinition | undefined {
    const short = metricShortName(metricId);
    const byAlias = this.catalog.metrics.get(short);
    if (byAlias) return byAlias;
    for (const metric of this.catalog.metrics.values()) if (metric.name === metricId) return metric;
    return undefined;
  }
}

function spanKindFrom(kind: SignalKind | string): SpanKind {
  const normalized = String(kind).toUpperCase();
  switch (normalized) {
    case SignalKind.INTERNAL: return SpanKind.INTERNAL;
    case SignalKind.CLIENT: return SpanKind.CLIENT;
    case SignalKind.SERVER: return SpanKind.SERVER;
    case SignalKind.PRODUCER: return SpanKind.PRODUCER;
    case SignalKind.CONSUMER: return SpanKind.CONSUMER;
    default: throw new TypeError("unsupported span kind");
  }
}

function getStreamLinks(parent: ObservationSpan | undefined, currentContext: Context) {
  const candidate = parent ? parent.spanContextInfo : trace.getSpan(currentContext)?.spanContext();
  return candidate?.traceId && candidate.spanId && candidate.traceId !== "00000000000000000000000000000000" && candidate.spanId !== "0000000000000000"
    ? [{ context: candidate }]
    : [];
}

const contextRoot = ROOT_CONTEXT;

const SEVERITY_NUMBERS: Readonly<Record<LogSeverity, SeverityNumber>> = {
  [LogSeverity.TRACE]: SeverityNumber.TRACE,
  [LogSeverity.DEBUG]: SeverityNumber.DEBUG,
  [LogSeverity.INFO]: SeverityNumber.INFO,
  [LogSeverity.WARN]: SeverityNumber.WARN,
  [LogSeverity.ERROR]: SeverityNumber.ERROR,
  [LogSeverity.FATAL]: SeverityNumber.FATAL,
};
