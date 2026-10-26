import {
  childSourcesIn,
  describeApplication,
  describedEnvironmentFor,
  environmentOwnerOf,
} from "@agboss/core/internal";
import { assembleApplication, loadCliApplication } from "./cli/cli-application.js";
import { textOption, type CommandHandler } from "./cli/context.js";
import { applicationData, describeData } from "./cli/describe-data.js";
import { envOption } from "./cli/environment.js";

/**
 * `agboss describe [--profile <p>] [--env <name>] [--json]` — the whole application (#268 AC4): its
 * tree of workflows, starts and children, implementations, model providers, channels, budgets and
 * environment, then every workflow in the order it runs them (the listed ones, then their child
 * workflows); no API key or network needed.
 */
export const handle: CommandHandler = async (context) => {
  const profile = textOption(context.values, "profile");
  const loaded = await loadCliApplication(context);
  const assembled = await assembleApplication(context, loaded, profile);
  const environment = await describedEnvironmentFor(
    environmentOwnerOf(assembled),
    envOption(context),
    context.io.env,
  );
  if (!context.json) {
    describeApplication(assembled, {
      source: loaded.path.shown,
      profile: profile ?? "base",
      ...(environment === undefined ? {} : { environment }),
    }).forEach(context.say);
    return {};
  }
  return {
    result: {
      application: applicationData(assembled, environment),
      workflows: assembled.workflows.map((workflow) =>
        describeData(workflow, profile ?? "base", environment, childSourcesIn(assembled.workflows)),
      ),
    },
  };
};
