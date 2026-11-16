import { validateAgentsConfig, type AgentsConfigOf } from "../config/types.js";
import { withNarrowedFiles } from "../files/assemble-files.js";
import type { AnyTool } from "../tools/index.js";
import { workflowModelUsesOf } from "../models/resolution.js";
import { resolveTools, type AssembledWorkflow } from "../workflow.js";
import type { TransportContainer } from "./late-transports.js";
import type { StartingModels } from "./models.js";

/**
 * Starts the workflow's models (#385: its container exists now) and gives its tools and its config
 * priced by its providers — with each agent's defaulted file types narrowed to the kinds its model
 * says it takes (#899).
 */
export async function startedModels(
  bundle: AssembledWorkflow,
  started: StartingModels,
  services: Parameters<AssembledWorkflow["resolve"]>[0],
  lifecycle: { readonly created: TransportContainer["created"] },
): Promise<{ readonly tools: readonly AnyTool[]; readonly config: AgentsConfigOf<string> }> {
  const inputs = await started.startModels({
    resolve: bundle.resolve(services),
    created: lifecycle.created,
  });
  const tools: readonly AnyTool[] = resolveTools(bundle, services);
  const priced = started.priced(
    validateAgentsConfig(
      bundle.config,
      tools.map((tool) => tool.name),
    ),
  );
  return { tools, config: withNarrowedFiles(priced, inputs, workflowModelUsesOf(bundle)) };
}
