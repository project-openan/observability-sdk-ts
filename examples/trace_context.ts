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

import { ObservabilitySdk, SignalKind, TraceContextPropagation } from "openan-observability-sdk";

const sdk = ObservabilitySdk.start({ serviceName: "a2a-client" });
const observe = sdk.observe();
const headers: Record<string, string> = {};
const client = observe.trace("SendMessage", SignalKind.CLIENT, { "operation.name": "SendMessage" });

await client.makeCurrent(() => TraceContextPropagation.inject(headers));
client.end();

await TraceContextPropagation.runWithExtracted(headers, async () => {
  const server = observe.trace("SendMessage", SignalKind.SERVER, { "operation.name": "SendMessage" });
  server.ok();
  server.end();
});

await sdk.close();
