import { describeWorkflow, loadWorkflow, withProfile } from "agboss";
import { describedEnvironmentFor } from "agboss/internal";
import { describeData } from "./cli/describe-data.js";
import { envOption, environmentOwner } from "./cli/environment.js";
import { loadOptions, textOption, workflowPath, type CommandHandler } from "./cli/context.js";

/** `agboss describe --workflow <path> [--profile <p>] [--env <name>] [--json]` — no API key or network needed. */
export const handle: CommandHandler = async (context) => {
  const profile = textOption(context.values, "profile");
  const file = workflowPath(context);
  const workflow = await loadWorkflow(file, loadOptions(context));
  const bundle = await withProfile(workflow, profile, context.io.cwd);
  const environment = await describedEnvironmentFor(
    await environmentOwner(context, file),
    envOption(context),
    context.io.env,
  );
  if (!context.json) {
    describeWorkflow(bundle, profile ?? "base", environment).forEach(context.say);
    return {};
  }
  return { result: describeData(bundle, profile ?? "base", environment) };
};
