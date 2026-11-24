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

const sdk = ObservabilitySdk.start({ serviceName: "workflow-agent" });
const observe = sdk.observe();
const workflow = {
  "workflow.id": "wf-001",
  "workflow.type": "fault-diagnosis",
  "workflow.status": "running",
  "workflow.session_id": "session-001",
};
const workflowSpan = observe.trace("a2at.workflow", SignalKind.INTERNAL, workflow);

await workflowSpan.makeCurrent(async () => {
  const step = observe.trace("a2at.step.collect", SignalKind.INTERNAL, {
    "workflow.step": "collect",
    "workflow.step.index": 1,
    "workflow.step.status": "completed",
    "workflow.step.owner_agent": "collector-agent",
  });
  step.ok();
  step.end();

  observe.metric("workflow.duration", 42, { "workflow.type": "fault-diagnosis", "workflow.status": "completed" });
  observe.log("gen_ai.agent.a2at.workflow", LogSeverity.INFO, "Workflow completed", {
    ...workflow,
    "workflow.status": "completed",
    "business.domain": "network-operations",
  });
  workflowSpan.ok();
});

workflowSpan.end();
await sdk.close();
