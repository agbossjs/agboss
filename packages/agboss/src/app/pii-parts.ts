import { randomBytes } from "node:crypto";
import type { AgentsConfigOf } from "../config/types.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { ModelGateway } from "../llm/gateway.js";
import { resolveSettings } from "../llm/registry.js";
import { modelDetectionOf } from "../pii/detectors/model.js";
import { piiRuntimeOf, type PiiRuntime } from "../pii/runtime.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";

/** A new key for the tokens of `sensitive` fields: one per application instance (#120). */
export const newPiiFieldKey = (): string => randomBytes(32).toString("hex");

/** What a workflow's PII runtime is built from at its start. */
export interface PiiParts {
  readonly gateway: ModelGateway;
  readonly services: WorkflowServices;
  readonly contexts: RuntimeContexts;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * A workflow's PII policies at run time (#120): instances from its container, each key read from
 * its process variable (a missing one fails the start), model detections on the gateway under
 * `pii:<policy>` with the workflow's chat defaults; `fieldKey` = the instance's key of `sensitive`
 * field tokens (absent = a new one: a workflow on its own).
 */
export function piiFor(
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  parts: PiiParts,
  fieldKey: string = newPiiFieldKey(),
): PiiRuntime {
  const resolve = bundle.resolve(parts.services);
  return piiRuntimeOf(bundle.pii, {
    resolve,
    processEnv: parts.env,
    contexts: parts.contexts,
    fieldKey,
    detectionOf: (policy, model) => {
      const settings = resolveSettings({ model }, config.defaults.models);
      const user = { kind: "pii-policy", policy } as const;
      return modelDetectionOf(policy, {
        model: parts.gateway.chatModel({ user, settings }),
        settings,
      });
    },
  });
}
