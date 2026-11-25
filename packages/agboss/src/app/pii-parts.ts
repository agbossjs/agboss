import type { AgentsConfigOf, ResolvedModelSettings } from "../config/types.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import { frameworkLogOf } from "../infrastructure/logger.js";
import type { ModelGateway } from "../llm/gateway.js";
import type { ModelPricing } from "../models/model-pricing.js";
import { resolveSettings } from "../llm/registry.js";
import { modelDetectionOf } from "../pii/detectors/model.js";
import { piiRuntimeOf, type PiiRuntime } from "../pii/runtime.js";
import { newPiiKey } from "../pii/tokens.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { ApplicationPiiKey } from "../application/application-pii.js";

/** What a workflow's PII runtime is built from at its start. */
export interface PiiParts {
  readonly gateway: ModelGateway;
  /** Prices a detection's model by its own provider and model (bughunt 2026-11-25 #2). */
  readonly pricing: ModelPricing;
  readonly services: WorkflowServices;
  readonly contexts: RuntimeContexts;
  readonly env: NodeJS.ProcessEnv;
}

/** The instance a workflow's PII runtime starts on: its key, and its log and clock. */
export interface PiiInstance {
  /** The instance's key of `sensitive` field tokens; absent = a new one (a workflow on its own). */
  readonly piiKey?: ApplicationPiiKey | undefined;
  /** A detection model that names a kind of no id is said on its log (#1301). */
  readonly infrastructure: Pick<Infrastructure, "logger" | "clock">;
}

/**
 * A `detectWithModel` policy's model settings: the model the cascade resolved for the policy (its
 * provider, #1313; else as written), priced by that provider's table for that model (bughunt #2).
 */
export function detectionSettingsOf(
  bundle: Pick<AssembledWorkflow, "pii">,
  config: Pick<AgentsConfigOf<string>, "defaults">,
  pricing: ModelPricing,
  asked: { readonly policy: string; readonly model: string },
): ResolvedModelSettings {
  const used = bundle.pii?.detectors.find((detector) => detector.name === asked.policy);
  return resolveSettings(
    pricing({
      model: used?.model ?? asked.model,
      ...(used?.modelProvider === undefined ? {} : { modelProvider: used.modelProvider }),
      ...(used?.unpriced === undefined ? {} : { unpriced: used.unpriced }),
    }),
    config.defaults.models,
  );
}

/**
 * A workflow's PII policies at run time (#120): instances from its container, each key read from
 * its process variable (a missing one fails the start), model detections on the gateway under
 * `pii:<policy>` with the workflow's chat defaults; `key` = the instance's key of `sensitive` field
 * tokens (absent = a new one: a workflow on its own) and whether it is the instance's own (#334);
 * a detection model's kind of no id is warned on the instance's log (#1301).
 */
export function piiFor(
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  parts: PiiParts,
  instance: PiiInstance,
): PiiRuntime {
  const key = instance.piiKey ?? { key: newPiiKey(), isInstanceKey: false };
  const log = frameworkLogOf(instance.infrastructure.logger, instance.infrastructure.clock);
  const resolve = bundle.resolve(parts.services);
  return piiRuntimeOf(bundle.pii, {
    resolve,
    processEnv: parts.env,
    contexts: parts.contexts,
    fieldKey: key.key,
    previousFieldKey: key.previousKey,
    isInstanceKey: key.isInstanceKey,
    detectionOf: (policy, model) => {
      const settings = detectionSettingsOf(bundle, config, parts.pricing, { policy, model });
      const user = { kind: "pii-policy", policy } as const;
      return modelDetectionOf(
        policy,
        { model: parts.gateway.chatModel({ user, settings }), settings },
        log,
      );
    },
  });
}
