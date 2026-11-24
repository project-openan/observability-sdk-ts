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

import { LogSeverity, ObservabilitySdk, SignalKind } from "openan-observability-sdk";

const sdk = ObservabilitySdk.start({
  serviceName: "task-t-agent",
  endpoint: "http://localhost:4318",
  protocol: "http/protobuf",
});
const observe = sdk.observe();
const attributes = { "extension.name": "task-t", "task.type": "diagnosis", "task.object": "router-17" };
const span = observe.trace("SendMessage", SignalKind.CLIENT, {
  "operation.name": "SendMessage",
  "task_id": "task-001",
  ...attributes,
});

await span.makeCurrent(async () => {
  observe.log("gen_ai.agent.a2at.message", LogSeverity.INFO, "Diagnosis request accepted", attributes, { span });
  observe.metric("task.duration", 1250, { "task.type": "diagnosis", "task.object": "router-17" });
  observe.metric("task.count", 1, { "task.type": "diagnosis" });
  span.ok();
});

span.end();
await sdk.flush();
await sdk.close();
