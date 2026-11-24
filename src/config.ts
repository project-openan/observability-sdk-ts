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
import { createSecureContext } from "node:tls";
import { URL } from "node:url";

const HEADER_NAME = /^[a-z0-9][a-z0-9_.-]*$/;

export type OtlpProtocol = "grpc" | "http/protobuf";

export interface BatchConfig {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduleDelayMillis?: number;
  exportTimeoutMillis?: number;
}

export interface SdkConfigOptions {
  endpoint?: string;
  protocol?: string;
  serviceName?: string;
  metricIntervalMillis?: number;
  exportTimeoutMillis?: number;
  headers?: Readonly<Record<string, string>>;
  trustedCertificate?: string;
  clientCertificate?: string;
  clientPrivateKey?: string;
  enabled?: boolean;
  spanBatch?: BatchConfig;
  logBatch?: BatchConfig;
}

export interface ResolvedBatchConfig {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduleDelayMillis: number;
  exportTimeoutMillis: number;
}

export interface ResolvedSdkConfig {
  endpoint: string;
  protocol: OtlpProtocol;
  serviceName: string;
  metricIntervalMillis: number;
  exportTimeoutMillis: number;
  headers: Readonly<Record<string, string>>;
  trustedCertificateData?: Buffer;
  clientCertificateData?: Buffer;
  clientPrivateKeyData?: Buffer;
  enabled: boolean;
  spanBatch: ResolvedBatchConfig;
  logBatch: ResolvedBatchConfig;
}

/** OTLP configuration. Durations in this API are expressed in milliseconds. */
export class SdkConfig {
  constructor(readonly options: SdkConfigOptions = {}) {}

  resolve(environ: NodeJS.ProcessEnv = process.env): ResolvedSdkConfig {
    const protocolValue = select(this.options.protocol, environ.OTEL_EXPORTER_OTLP_PROTOCOL, "grpc").toLowerCase();
    if (protocolValue !== "grpc" && protocolValue !== "http/protobuf") {
      throw new TypeError("Invalid OTEL_EXPORTER_OTLP_PROTOCOL");
    }
    const protocol: OtlpProtocol = protocolValue;
    const defaultEndpoint = protocol === "grpc" ? "http://localhost:4317" : "http://localhost:4318";
    const endpoint = select(this.options.endpoint, environ.OTEL_EXPORTER_OTLP_ENDPOINT, defaultEndpoint).replace(/\/+$/, "");
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new TypeError("Invalid OTEL_EXPORTER_OTLP_ENDPOINT");
    }
    if (
      !["http:", "https:"].includes(parsedEndpoint.protocol) ||
      !parsedEndpoint.hostname ||
      parsedEndpoint.username ||
      parsedEndpoint.password ||
      parsedEndpoint.search ||
      parsedEndpoint.hash
    ) {
      throw new TypeError("Invalid OTEL_EXPORTER_OTLP_ENDPOINT");
    }

    const serviceName = select(this.options.serviceName, environ.OTEL_SERVICE_NAME, "unknown_service");
    if (!serviceName.trim()) throw new TypeError("serviceName is empty");
    const enabled = this.options.enabled ?? true;
    if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");

    const metricIntervalMillis = positiveInteger(
      this.options.metricIntervalMillis ?? parseEnvironmentMillis(environ.OTEL_METRIC_EXPORT_INTERVAL, 60_000),
      "Invalid OTEL_METRIC_EXPORT_INTERVAL",
    );
    const exportTimeoutMillis = nonNegativeInteger(
      this.options.exportTimeoutMillis ?? parseEnvironmentMillis(environ.OTEL_EXPORTER_OTLP_TIMEOUT, 10_000),
      "Invalid OTEL_EXPORTER_OTLP_TIMEOUT",
    );

    const sourceHeaders = this.options.headers ?? parseHeaders(environ.OTEL_EXPORTER_OTLP_HEADERS);
    const headers = normalizeHeaders(sourceHeaders);

    const caPath = this.options.trustedCertificate ?? environ.OTEL_EXPORTER_OTLP_CERTIFICATE;
    const clientCertificatePath = this.options.clientCertificate;
    const clientPrivateKeyPath = this.options.clientPrivateKey;
    if (caPath && parsedEndpoint.protocol !== "https:") {
      throw new TypeError("OTEL_EXPORTER_OTLP_CERTIFICATE requires an https endpoint");
    }
    if ((clientCertificatePath === undefined) !== (clientPrivateKeyPath === undefined)) {
      throw new TypeError("Client certificate and private key must be configured together");
    }
    if ((clientCertificatePath || clientPrivateKeyPath) && parsedEndpoint.protocol !== "https:") {
      throw new TypeError("Client TLS requires an https endpoint");
    }

    let trustedCertificateData: Buffer | undefined;
    let clientCertificateData: Buffer | undefined;
    let clientPrivateKeyData: Buffer | undefined;
    try {
      if (caPath) trustedCertificateData = readCertificate(caPath, "Invalid OTEL_EXPORTER_OTLP_CERTIFICATE");
      if (clientCertificatePath && clientPrivateKeyPath) {
        clientCertificateData = readCertificate(clientCertificatePath, "Invalid OTLP client certificate");
        clientPrivateKeyData = readFileSync(clientPrivateKeyPath);
        createSecureContext({
          ca: trustedCertificateData,
          cert: clientCertificateData,
          key: clientPrivateKeyData,
        });
      } else if (trustedCertificateData) {
        createSecureContext({ ca: trustedCertificateData });
      }
    } catch {
      throw new TypeError("Invalid OTLP TLS configuration");
    }

    const result: ResolvedSdkConfig = {
      endpoint,
      protocol,
      serviceName,
      metricIntervalMillis,
      exportTimeoutMillis,
      headers,
      enabled,
      spanBatch: resolveBatch(this.options.spanBatch, { maxQueueSize: 2048, maxExportBatchSize: 512, scheduleDelayMillis: 5000, exportTimeoutMillis: 30000 }),
      logBatch: resolveBatch(this.options.logBatch, { maxQueueSize: 2048, maxExportBatchSize: 512, scheduleDelayMillis: 1000, exportTimeoutMillis: 30000 }),
    };
    if (trustedCertificateData) result.trustedCertificateData = trustedCertificateData;
    if (clientCertificateData) result.clientCertificateData = clientCertificateData;
    if (clientPrivateKeyData) result.clientPrivateKeyData = clientPrivateKeyData;
    return result;
  }
}

function resolveBatch(config: BatchConfig | undefined, defaults: ResolvedBatchConfig): ResolvedBatchConfig {
  const result = { ...defaults, ...config };
  if (!Number.isSafeInteger(result.maxQueueSize) || result.maxQueueSize < 1) {
    throw new TypeError("maxQueueSize must be positive");
  }
  if (!Number.isSafeInteger(result.maxExportBatchSize) || result.maxExportBatchSize < 1 || result.maxExportBatchSize > result.maxQueueSize) {
    throw new TypeError("maxExportBatchSize must be positive and no larger than maxQueueSize");
  }
  for (const [name, value] of [["scheduleDelayMillis", result.scheduleDelayMillis], ["exportTimeoutMillis", result.exportTimeoutMillis]] as const) {
    if (!Number.isFinite(value) || value < 0 || (name === "scheduleDelayMillis" && value === 0)) {
      throw new TypeError(`${name} must be ${name === "scheduleDelayMillis" ? "positive" : "non-negative"}`);
    }
  }
  return result;
}

function select(explicit: string | undefined, environment: string | undefined, fallback: string): string {
  return explicit ?? (environment?.trim() ? environment : fallback);
}

function parseEnvironmentMillis(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new TypeError("Invalid OTLP duration environment variable");
  return result;
}

function positiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(message);
  return value;
}

function nonNegativeInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(message);
  return value;
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  const headers: Record<string, string> = {};
  try {
    for (const pair of value.split(",")) {
      const separator = pair.indexOf("=");
      if (separator < 1) throw new Error();
      const name = pair.slice(0, separator);
      const headerValue = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, " "));
      if (Object.hasOwn(headers, name)) throw new Error();
      headers[name] = headerValue;
    }
  } catch {
    throw new TypeError("Invalid OTEL_EXPORTER_OTLP_HEADERS");
  }
  return headers;
}

function normalizeHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (!HEADER_NAME.test(key) || typeof value !== "string" || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || Object.hasOwn(normalized, key)) {
        throw new Error();
      }
      normalized[key] = value;
    }
  } catch {
    throw new TypeError("Invalid OTLP request headers");
  }
  return Object.freeze(normalized);
}

function readCertificate(path: string, errorMessage: string): Buffer {
  const data = readFileSync(path);
  if (data.length === 0 || !data.includes(Buffer.from("-----BEGIN CERTIFICATE-----"))) {
    throw new TypeError(errorMessage);
  }
  return data;
}
