import { describeWorkflow } from "agboss";
import { describedEnvironmentFor, environmentOwnerOf } from "agboss/internal";
import { assembleApplication, loadCliApplication } from "./cli/cli-application.js";
import { textOption, type CommandHandler } from "./cli/context.js";
import { describeData } from "./cli/describe-data.js";
import { envOption } from "./cli/environment.js";

/**
 * `agboss describe [--profile <p>] [--env <name>] [--json]` — every workflow of the application, in
 * the order it runs them (the listed ones, then their child workflows); no API key or network needed.
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
    context.say(`${assembled.name} ${assembled.version} (${loaded.path.shown})`);
    for (const workflow of assembled.workflows) {
      context.say("");
      describeWorkflow(workflow, profile ?? "base", environment).forEach(context.say);
    }
    return {};
  }
  return {
    result: {
      application: { name: assembled.name, version: assembled.version },
      workflows: assembled.workflows.map((workflow) =>
        describeData(workflow, profile ?? "base", environment),
      ),
    },
  };
};
