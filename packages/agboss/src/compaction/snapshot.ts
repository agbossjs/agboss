import type { AssembledCompactions } from "./assembly.js";
import { CompactionStrategy } from "./compaction.decorator.js";

/** What a workflow's compactions summarise with: their strategy and prompt, by name. */
export const compactionSnapshot = (compactions: AssembledCompactions | undefined): object =>
  compactions === undefined || compactions.compactions.length === 0
    ? {}
    : {
        compactions: compactions.compactions.map(({ name, strategy, prompt, type }) => ({
          name,
          strategy,
          prompt,
          // a custom one (#382): the class that compacts — swapping it changes the hash
          ...(strategy === CompactionStrategy.Custom ? { handler: `${type.name}.compact()` } : {}),
        })),
      };
