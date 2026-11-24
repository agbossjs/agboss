import type { AgentsConfigOf } from "../config/types.js";
import type { WorkflowPatch } from "../config/workflow-overlay.js";

export type { WorkflowPatch };
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
