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

import type { AttributeValue, Attributes } from "@opentelemetry/api";
import { SIGNAL_CATALOG, shortName, type SignalCatalog, type SignalDefinition } from "./definitions.js";

const A2AT_PREFIX = "gen_ai.agent.a2at.";
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const QUOTED_CREDENTIAL = /((?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi;
const CREDENTIAL = /(bearer\s+)[^\s,;"']+|((?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s,;"']+/gi;

export function clean(value: string): string {
  const cleaned = value
    .replace(QUOTED_CREDENTIAL, "$1[REDACTED]")
    .replace(CREDENTIAL, "$1$2[REDACTED]")
    .replace(URL_PATTERN, (match) => cleanUrl(match));
  return cleaned.slice(0, 2048);
}

function cleanUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return "[REDACTED_URL]";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

export function selectExtension(
  attributes: Readonly<Record<string, unknown>>,
  definitions: ReadonlyMap<string, SignalDefinition>,
  catalog: SignalCatalog = SIGNAL_CATALOG,
): SignalDefinition | undefined {
  let found = false;
  let extensionValue: unknown;
  for (const [rawKey, value] of Object.entries(attributes)) {
    if (shortName(rawKey, catalog) === "extension.name") {
      if (found) throw new TypeError("duplicate extension.name");
      found = true;
      extensionValue = value;
    }
  }
  if (!found) return undefined;
  if (typeof extensionValue !== "string") throw new TypeError("extension.name must be a string");
  return definitions.get(extensionValue.toLowerCase());
}

export function validateAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
  signal: "S" | "M" | "L",
  definition: SignalDefinition | undefined,
  catalog: SignalCatalog = SIGNAL_CATALOG,
  options: { requireFields?: boolean; allowed?: ReadonlySet<string> } = {},
): Attributes {
  const input = attributes ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("attributes must be a mapping");

  const converted: Record<string, AttributeValue> = {};
  const seen = new Set<string>();
  const shortValues = new Map<string, unknown>();
  for (const [rawKey, value] of Object.entries(input)) {
    const key = shortName(rawKey, catalog);
    const attribute = catalog.attributes.get(key);
    if (!attribute) throw new TypeError("unknown attribute");
    if (rawKey !== key && rawKey !== attribute.name) throw new TypeError("attribute name must use its short or declared OpenTelemetry form");
    if (seen.has(key)) throw new TypeError("duplicate attribute");
    if (!attribute.signals.includes(signal)) throw new TypeError("attribute is not allowed for this signal type");
    if (options.allowed && !options.allowed.has(key)) throw new TypeError("attribute is not allowed for this signal");
    const normalized = convertValue(key, value, attribute.valueType, attribute.values);
    seen.add(key);
    shortValues.set(key, normalized);
    converted[attribute.name] = normalized;
  }

  if (definition) {
    if ((options.requireFields ?? true) && [...definition.required].some((key) => !seen.has(key))) {
      throw new TypeError("required attribute is missing");
    }
    const extension = shortValues.get("extension.name");
    const taskType = shortValues.get("task.type");
    if (definition.extension && extension !== definition.extension) throw new TypeError("extension.name does not match the selected extension");
    if (typeof taskType === "string" && !taskType.trim()) throw new TypeError("task.type must not be blank");
  }
  return converted;
}

function convertValue(
  key: string,
  value: unknown,
  valueType: "string" | "integer" | "boolean" | "string_array",
  allowedValues: ReadonlySet<string>,
): AttributeValue {
  if (valueType === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError("attribute must be a safe integer");
    if (key === "parts.number" && value < 0) throw new TypeError("parts.number cannot be negative");
    return value;
  }
  if (valueType === "boolean") {
    if (typeof value !== "boolean") throw new TypeError("attribute must be a boolean");
    return value;
  }
  if (valueType === "string_array") {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
      throw new TypeError("attribute must be a non-empty string array");
    }
    return value.map((item) => clean(item as string));
  }
  if (typeof value !== "string") throw new TypeError("attribute must be a string");
  let result = value;
  if (allowedValues.size > 0) {
    result = value.toLowerCase();
    if (!allowedValues.has(result)) throw new TypeError("attribute has an unsupported value");
  }
  if (key === "gen_ai.system" && result !== "a2a") throw new TypeError("gen_ai.system must be a2a");
  if (key === "operation.name" && !result.trim()) throw new TypeError("operation.name must not be blank");
  return clean(result);
}

export function convertGeneralLogAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): Attributes {
  const input = attributes ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("attributes must be a mapping");

  const converted = Object.create(null) as Record<string, AttributeValue>;
  for (const [key, value] of Object.entries(input)) {
    if (!key.trim() || value === null || value === undefined) throw new TypeError("invalid general log attribute");
    if (typeof value === "string") converted[key] = clean(value);
    else if (typeof value === "boolean") converted[key] = value;
    else if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new TypeError("invalid general log number");
      }
      converted[key] = value;
    } else if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) {
      converted[key] = value.map(clean);
    } else {
      throw new TypeError("unsupported general log attribute type");
    }
  }
  return converted;
}

export function metricShortName(name: string): string {
  return name.startsWith(A2AT_PREFIX) ? name.slice(A2AT_PREFIX.length) : name;
}
