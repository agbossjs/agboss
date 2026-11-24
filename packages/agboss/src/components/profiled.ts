import type { AgentsConfigOf } from "../config/types.js";
import type { WorkflowPatch } from "../config/workflow-overlay.js";

export type { WorkflowPatch };
import type { Class } from "./injection.js";
import { windowOfClass, type UncompactedTurns } from "../memory/memory.decorator.js";
import type { WorkflowMeta } from "./meta-types.js";

/**
 * A workflow under the selected profiles (`src/config/`): its model cascade, its config constants and
 * its prompts. The constants go on before the cascade resolves, so a role a profile names resolves
 * like a declared one; nothing the decorators declared is changed.
 */

/** The workflow's model cascade under the profiles: their provider for the workflow, their model names. */
export const profiledBundle = (
  bundle: WorkflowMeta,
  patch: WorkflowPatch | undefined,
): WorkflowMeta =>
  patch === undefined
    ? bundle
    : {
        ...bundle,
        ...(patch.slots.memory === undefined ? {} : { memory: patch.slots.memory }),
        memoryOverrides: patch.memoryOverrides,
        pauseOverrides: patch.pauseOverrides,
        modelCascade: {
          ...bundle.modelCascade,
          ...(patch.modelProvider === undefined ? {} : { workflow: patch.modelProvider }),
          providerOverlays: patch.providers,
          componentModels: patch.componentModels,
        },
      };

/** The config with the profiles' constants applied. */
export const patchedConfig = (
  config: AgentsConfigOf<string>,
  patch: WorkflowPatch | undefined,
): AgentsConfigOf<string> => (patch === undefined ? config : patch.config(config));

/** The prompts with the profiles' prompt overrides in place of the declared ones. */
export const patchedPrompts = <TPrompts extends Readonly<Record<string, unknown>>>(
  prompts: TPrompts,
  patch: WorkflowPatch | undefined,
): TPrompts =>
  patch === undefined ? prompts : (patch.prompts(prompts as Record<string, string>) as TPrompts);

/** The workflow's own `@Memory`: a profile's class slot over `@Workflow({ memory })`. */
export const memoryOf = (
  options: { readonly memory?: Class },
  patch: WorkflowPatch | undefined,
): Class | undefined => patch?.slots.memory ?? options.memory;

/** The window of a workflow's memory as the profiles leave it; `undefined` without a memory. */
export const windowOf = (
  memory: Class | undefined,
  patch: WorkflowPatch | undefined,
): UncompactedTurns | undefined =>
  memory === undefined ? undefined : windowOfClass(memory, patch?.memoryOverrides);
