import {
  applicationDataOf,
  childSourcesIn,
  describeAssembledApplication,
  workflowDataOf,
} from "@agboss/core/internal";
import { assembleApplication, loadCliApplication } from "./cli/cli-application.js";
import { textOption, type CommandHandler } from "./cli/context.js";

/**
 * `agboss describe [--profile <p>] [--json]` — the whole application (#268 AC4): its
 * tree of workflows, starts and children, implementations, model providers, channels and budgets,
 * then every workflow in the order it runs them (the listed ones, then their child
 * workflows); no API key or network needed.
 */
export const handle: CommandHandler = async (context) => {
  const profile = textOption(context.values, "profile");
  const loaded = await loadCliApplication(context);
  const assembled = await assembleApplication(context, loaded, profile);
  if (!context.json) {
    describeAssembledApplication(assembled, {
      source: loaded.path.shown,
      profile: profile ?? "base",
    }).forEach(context.say);
    return {};
  }
  return {
    result: {
      application: applicationDataOf(assembled),
      workflows: assembled.workflows.map((workflow) =>
        workflowDataOf(workflow, profile ?? "base", childSourcesIn(assembled.workflows)),
      ),
    },
  };
};
