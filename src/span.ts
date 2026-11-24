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

import { context, SpanStatusCode, type Context, type Span, type SpanContext as OtelSpanContext } from "@opentelemetry/api";
import { validateAttributes } from "./_attributes.js";
import type { SignalCatalog, SignalDefinition } from "./definitions.js";

export class ObservationSpan {
  private ended = false;

  constructor(
    private readonly span: Span | undefined,
    private readonly spanContext: Context,
    private readonly definition: SignalDefinition | undefined,
    private readonly catalog: SignalCatalog,
  ) {}

  get context(): Context {
    return this.spanContext;
  }

  get valid(): boolean {
    return this.span !== undefined;
  }

  get spanContextInfo(): OtelSpanContext | undefined {
    return this.span?.spanContext();
  }

  attributes(attributes: Readonly<Record<string, unknown>>): void {
    if (!this.span || !this.definition || this.ended) return;
    try {
      this.span.setAttributes(validateAttributes(attributes, "S", this.definition, this.catalog, { requireFields: false }));
    } catch {
      diagnostics.warn("Observation span attributes rejected");
    }
  }

  ok(): void {
    if (this.span && !this.ended) this.span.setStatus({ code: SpanStatusCode.OK });
  }

  error(error?: Error): void {
    if (!this.span || this.ended) return;
    if (error) this.span.recordException(error);
    this.span.setStatus({ code: SpanStatusCode.ERROR });
  }

  makeCurrent<T>(callback: () => T): T {
    return context.with(this.spanContext, callback);
  }

  close(): void {
    if (!this.span || this.ended) return;
    this.ended = true;
    this.span.end();
  }

  end(): void {
    this.close();
  }
}

const diagnostics = {
  warn(message: string): void {
    // Keep diagnostics value-free so rejected attributes cannot leak credentials.
    console.warn(message);
  },
};
