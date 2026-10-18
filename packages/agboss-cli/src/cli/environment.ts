import { type Environment } from "agboss";
import { environmentFor, environmentOwnerOfFile, type EnvironmentOwner } from "agboss/internal";
import { resolve } from "node:path";
import { loadOptions, textOption, type CommandContext } from "./context.js";

/** `--env <name>`; undefined = the default (`dev`, of an application that declares an environment). */
export const envOption = (context: CommandContext): string | undefined =>
  textOption(context.values, "env");

/** The application that lists the workflow file: where its environments are, and its contract. */
export const environmentOwner = (
  context: CommandContext,
  workflowFile: string,
): Promise<EnvironmentOwner> => environmentOwnerOfFile(resolve(workflowFile), loadOptions(context));

/** The environment of the workflow file's application, resolved against the CLI's process env. */
export const cliEnvironment = async (
  context: CommandContext,
  workflowFile: string,
): Promise<Environment | undefined> =>
  environmentFor(
    await environmentOwner(context, workflowFile),
    { env: envOption(context) },
    context.io.env,
  );
