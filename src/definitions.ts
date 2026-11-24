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

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface AttributeDefinition {
  readonly name: string;
  readonly signals: string;
  readonly valueType: "string" | "integer" | "boolean" | "string_array";
  readonly values: ReadonlySet<string>;
}

export interface SignalDefinition {
  readonly extension?: string;
  readonly allowed: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

export interface MetricDefinition {
  readonly name: string;
  readonly histogram: boolean;
  readonly integer: boolean;
  readonly a2a: boolean;
  readonly unit: string;
  readonly allowed: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

interface NamedSignalDefinition {
  readonly name?: string;
  readonly namePrefix?: string;
  readonly signal: SignalDefinition;
}

export interface A2aProtocolDefinition {
  readonly attributePrefix: string;
  readonly message: string;
  readonly stream: string;
  readonly streamEvent: string;
  readonly streamError: string;
  readonly streamNegotiation: string;
  readonly traceNames: ReadonlySet<string>;
  readonly clientOnlyTraces: ReadonlySet<string>;
  readonly serverOnlyTraces: ReadonlySet<string>;
  readonly span: SignalDefinition;
  readonly streamEventSpan: SignalDefinition;
  readonly streamNegotiationSpan: SignalDefinition;
}

export interface SignalCatalog {
  readonly attributes: ReadonlyMap<string, AttributeDefinition>;
  readonly metrics: ReadonlyMap<string, MetricDefinition>;
  readonly spans: ReadonlyMap<string, SignalDefinition>;
  readonly logs: ReadonlyMap<string, SignalDefinition>;
  readonly versions: ReadonlyMap<string, string>;
  readonly a2a: A2aProtocolDefinition;
  namedTrace(name: string): SignalDefinition | undefined;
  namedLog(name: string): SignalDefinition | undefined;
}

type Mapping = Record<string, unknown>;
const A2AT_PREFIX = "gen_ai.agent.a2at.";

export function loadCatalog(): SignalCatalog {
  const attributes = new Map<string, AttributeDefinition>();
  const metrics = new Map<string, MetricDefinition>();
  const spans = new Map<string, SignalDefinition>();
  const logs = new Map<string, SignalDefinition>();
  const traces = new Map<string, NamedSignalDefinition>();
  const namedLogs = new Map<string, NamedSignalDefinition>();
  const versions = new Map<string, string>();
  let a2a: A2aProtocolDefinition | undefined;

  for (const filename of ["a2at.yaml", "agent.yaml", "workflow.yaml"]) {
    let root: Mapping;
    try {
      const source = readFileSync(new URL(`./config/${filename}`, import.meta.url), "utf8");
      root = mapping(parse(source), filename);
    } catch {
      throw new Error(`Invalid signal configuration: ${filename}`);
    }
    const signalName = stringValue(root.signal, `${filename}.signal`);
    const version = stringValue(root.version, `${filename}.version`);
    if (versions.has(signalName)) throw new Error(`Duplicate signal configuration: ${signalName}`);
    versions.set(signalName, version);

    for (const [key, raw] of Object.entries(mapping(root.attributes ?? {}, `${filename}.attributes`))) {
      const item = mapping(raw, `${filename}.attributes.${key}`);
      const valueType = stringValue(item.type, `${filename}.attributes.${key}.type`).toLowerCase() as AttributeDefinition["valueType"];
      if (!["string", "integer", "boolean", "string_array"].includes(valueType)) throw new Error(`Unsupported attribute type at ${filename}.attributes.${key}`);
      const values = new Set(stringList(item.values ?? [], `${filename}.attributes.${key}.values`));
      if (values.size > 0 && key !== "extension.name") throw new Error(`Only extension.name may declare values at ${filename}.attributes.${key}`);
      const signals = item.signals ?? "SML";
      if (typeof signals !== "string" || !signals || [...signals].some((char) => !"SML".includes(char))) throw new Error(`Invalid attribute signals at ${filename}.attributes.${key}.signals`);
      const definition: AttributeDefinition = Object.freeze({
        name: stringValue(item.otel_name, `${filename}.attributes.${key}.otel_name`),
        signals,
        valueType,
        values,
      });
      const previous = attributes.get(key);
      if (previous && (previous.name !== definition.name || previous.signals !== definition.signals || previous.valueType !== definition.valueType || !sameSet(previous.values, values))) {
        throw new Error(`Conflicting attribute definition: ${key}`);
      }
      attributes.set(key, definition);
    }

    for (const [key, raw] of Object.entries(mapping(root.metrics ?? {}, `${filename}.metrics`))) {
      const item = mapping(raw, `${filename}.metrics.${key}`);
      const attributeSpec = mapping(item.attributes, `${filename}.metrics.${key}.attributes`);
      const metricType = stringValue(item.type, `${filename}.metrics.${key}.type`);
      const valueType = stringValue(item.value_type, `${filename}.metrics.${key}.value_type`);
      const protocol = item.protocol;
      if (!["histogram", "counter"].includes(metricType) || !["integer", "number"].includes(valueType) || (protocol !== undefined && protocol !== "a2a")) {
        throw new Error(`Unsupported metric definition at ${filename}.metrics.${key}`);
      }
      if (metrics.has(key)) throw new Error(`Duplicate metric: ${key}`);
      metrics.set(key, Object.freeze({
        name: stringValue(item.otel_name, `${filename}.metrics.${key}.otel_name`),
        histogram: metricType === "histogram",
        integer: valueType === "integer",
        a2a: protocol === "a2a",
        unit: stringValue(item.unit, `${filename}.metrics.${key}.unit`, true),
        allowed: new Set(stringList(attributeSpec.allowed, `${filename}.metrics.${key}.attributes.allowed`)),
        required: new Set(stringList(attributeSpec.required, `${filename}.metrics.${key}.attributes.required`)),
      }));
    }

    for (const [extension, raw] of Object.entries(mapping(root.extensions ?? {}, `${filename}.extensions`))) {
      const item = mapping(raw, `${filename}.extensions.${extension}`);
      if (spans.has(extension) || logs.has(extension)) throw new Error(`Duplicate extension: ${extension}`);
      spans.set(extension, signal(item.span_attributes, `${filename}.extensions.${extension}.span_attributes`, extension));
      logs.set(extension, signal(item.log_attributes, `${filename}.extensions.${extension}.log_attributes`, extension));
    }
    loadNamedSignals(root.traces ?? {}, `${filename}.traces`, traces);
    loadNamedSignals(root.logs ?? {}, `${filename}.logs`, namedLogs);

    if (Object.hasOwn(root, "a2a")) {
      if (a2a) throw new Error("Duplicate A2A protocol configuration");
      const protocol = mapping(root.a2a, `${filename}.a2a`);
      const special = mapping(protocol.special_traces, `${filename}.a2a.special_traces`);
      const message = stringValue(special.message, `${filename}.a2a.special_traces.message`);
      const stream = stringValue(special.stream, `${filename}.a2a.special_traces.stream`);
      const streamEvent = stringValue(special.stream_event, `${filename}.a2a.special_traces.stream_event`);
      const streamError = stringValue(special.stream_error, `${filename}.a2a.special_traces.stream_error`);
      const streamNegotiation = stringValue(special.stream_negotiation, `${filename}.a2a.special_traces.stream_negotiation`);
      const traceNames = new Set(stringList(protocol.trace_names, `${filename}.a2a.trace_names`));
      const clientOnlyTraces = new Set(stringList(protocol.client_only_traces, `${filename}.a2a.client_only_traces`));
      const serverOnlyTraces = new Set(stringList(protocol.server_only_traces ?? [], `${filename}.a2a.server_only_traces`));
      if (![message, stream, streamEvent, streamError, streamNegotiation].every((name) => traceNames.has(name))
        || [...clientOnlyTraces].some((name) => !traceNames.has(name))
        || [...serverOnlyTraces].some((name) => !traceNames.has(name) || clientOnlyTraces.has(name))) {
        throw new Error(`A2A special traces must be listed at ${filename}.a2a`);
      }
      a2a = Object.freeze({
        attributePrefix: stringValue(protocol.attribute_prefix, `${filename}.a2a.attribute_prefix`),
        message,
        stream,
        streamEvent,
        streamError,
        streamNegotiation,
        traceNames,
        clientOnlyTraces,
        serverOnlyTraces,
        span: signal(protocol.span_attributes, `${filename}.a2a.span_attributes`),
        streamEventSpan: signal(protocol.stream_event_attributes, `${filename}.a2a.stream_event_attributes`),
        streamNegotiationSpan: signal(protocol.stream_negotiation_attributes, `${filename}.a2a.stream_negotiation_attributes`, "negotiation-t"),
      });
    }
  }
  if (!a2a) throw new Error("Missing A2A protocol configuration");
  return Object.freeze({
    attributes,
    metrics,
    spans,
    logs,
    versions,
    a2a,
    namedTrace: (name: string) => findNamed(traces, name),
    namedLog: (name: string) => findNamed(namedLogs, name),
  });
}

export const SIGNAL_CATALOG = loadCatalog();

export function shortName(name: string, catalog: SignalCatalog = SIGNAL_CATALOG): string {
  if (name.startsWith(catalog.a2a.attributePrefix)) return name.slice(catalog.a2a.attributePrefix.length);
  if (name.startsWith(A2AT_PREFIX)) return name.slice(A2AT_PREFIX.length);
  return name;
}

function loadNamedSignals(value: unknown, path: string, target: Map<string, NamedSignalDefinition>): void {
  for (const [key, raw] of Object.entries(mapping(value, path))) {
    const item = mapping(raw, `${path}.${key}`);
    const name = item.name;
    const namePrefix = item.name_prefix;
    if ((name === undefined) === (namePrefix === undefined)) throw new Error(`Provide exactly one name or name_prefix at ${path}.${key}`);
    if (target.has(key)) throw new Error(`Duplicate named signal: ${key}`);
    const definition: NamedSignalDefinition = {
      ...(name !== undefined ? { name: stringValue(name, `${path}.${key}.name`) } : {}),
      ...(namePrefix !== undefined ? { namePrefix: stringValue(namePrefix, `${path}.${key}.name_prefix`) } : {}),
      signal: signal(item.attributes, `${path}.${key}.attributes`),
    };
    target.set(key, definition);
  }
}

function findNamed(definitions: Map<string, NamedSignalDefinition>, candidate: string): SignalDefinition | undefined {
  for (const item of definitions.values()) {
    if (item.name === candidate || (item.namePrefix && candidate.startsWith(item.namePrefix) && candidate.length > item.namePrefix.length)) return item.signal;
  }
  return undefined;
}

function signal(value: unknown, path: string, extension?: string): SignalDefinition {
  const item = mapping(value, path);
  return Object.freeze({
    ...(extension ? { extension } : {}),
    allowed: new Set(stringList(item.allowed, `${path}.allowed`)),
    required: new Set(stringList(item.required, `${path}.required`)),
  });
}

function mapping(value: unknown, path: string): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Expected mapping at ${path}`);
  return value as Mapping;
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`Expected string at ${path}`);
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Expected list at ${path}`);
  const values = value.map((entry) => stringValue(entry, path));
  if (new Set(values).size !== values.length) throw new Error(`Duplicate value at ${path}`);
  return values;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}
