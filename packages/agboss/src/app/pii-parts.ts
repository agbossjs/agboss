import type { AgentsConfigOf } from "../config/types.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { ModelGateway } from "../llm/gateway.js";
import { resolveSettings } from "../llm/registry.js";
import { modelDetectionOf } from "../pii/detectors/model.js";
import { piiRuntimeOf, type PiiRuntime } from "../pii/runtime.js";
import { newPiiKey } from "../pii/tokens.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { ApplicationPiiKey } from "../application/application-pii.js";

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
 * `pii:<policy>` with the workflow's chat defaults; `key` = the instance's key of `sensitive` field
 * tokens (absent = a new one: a workflow on its own) and whether it is the instance's own (#334).
 */
export function piiFor(
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  parts: PiiParts,
  key: ApplicationPiiKey = { key: newPiiKey(), isInstanceKey: false },
): PiiRuntime {
  const resolve = bundle.resolve(parts.services);
  return piiRuntimeOf(bundle.pii, {
    resolve,
    processEnv: parts.env,
    contexts: parts.contexts,
    fieldKey: key.key,
    isInstanceKey: key.isInstanceKey,
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
