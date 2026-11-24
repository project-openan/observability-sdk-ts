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

import { context, type Context, type TextMapGetter, type TextMapSetter } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

const PROPAGATOR = new W3CTraceContextPropagator();

export class TraceContextPropagation {
  static inject<Carrier>(carrier: Carrier, setter: TextMapSetter<Carrier> = objectSetter as TextMapSetter<Carrier>): Carrier {
    if (carrier === undefined || carrier === null) throw new TypeError("carrier is required");
    PROPAGATOR.inject(context.active(), carrier, setter);
    return carrier;
  }

  static extract<Carrier>(carrier: Carrier, getter: TextMapGetter<Carrier> = objectGetter as TextMapGetter<Carrier>): Context {
    if (carrier === undefined || carrier === null) throw new TypeError("carrier is required");
    return PROPAGATOR.extract(context.active(), carrier, getter);
  }

  static runWithExtracted<Carrier, Result>(
    carrier: Carrier,
    callback: () => Result,
    getter: TextMapGetter<Carrier> = objectGetter as TextMapGetter<Carrier>,
  ): Result {
    if (typeof callback !== "function") throw new TypeError("callback is required");
    return context.with(this.extract(carrier, getter), callback);
  }

  /** Attaches extracted context until dispose() is called. Prefer runWithExtracted for async callbacks. */
  static extractToCurrent<Carrier>(
    carrier: Carrier,
    getter: TextMapGetter<Carrier> = objectGetter as TextMapGetter<Carrier>,
  ): { dispose(): void } {
    return context.attach(this.extract(carrier, getter));
  }
}

const objectSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const objectGetter: TextMapGetter<Readonly<Record<string, string | string[] | undefined>>> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    return carrier[key];
  },
};
