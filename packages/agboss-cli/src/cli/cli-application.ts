import type { AssembledWorkflow, Class, Environment } from "@agboss/core";
import {
  applicationOf,
  environmentFor,
  environmentOwnerOf,
  loadApplicationClass,
  startsOfApplication,
  type ApplicationStart,
  type AssembledApplication,
} from "@agboss/core/internal";
import { applicationPathOf, type ApplicationPath } from "./application-path.js";
import { loadOptions, type CommandContext } from "./context.js";
import { envOption } from "./environment.js";
import { startOf } from "./start-choice.js";

/**
 * The application a command works on (#268): the module of its path loaded, its starts read from
 * the decorators. Commands that run one workflow choose it by `--start`; the others work on every
 * workflow of the application.
 */
export interface CliApplication {
  readonly path: ApplicationPath;
  readonly application: Class;
  readonly starts: readonly ApplicationStart[];
}

/** The `@Application` of `--application` / `package.json`, and its starts. */
export async function loadCliApplication(context: CommandContext): Promise<CliApplication> {
  const path = applicationPathOf(context);
  const application = await loadApplicationClass(path.file, loadOptions(context));
  return {
    path,
    application,
    starts: startsOfApplication(application, `agboss ${context.command}`),
  };
}

/** The application with the start `--start` names (the only one when it has one). */
export interface ChosenStart extends CliApplication {
  readonly start: ApplicationStart;
}

export async function loadChosenStart(context: CommandContext): Promise<ChosenStart> {
  const loaded = await loadCliApplication(context);
  return { ...loaded, start: startOf(context, loaded.starts) };
}

/** The whole application assembled as `createApp` assembles it (no instance, nothing started). */
export const assembleApplication = (
  context: CommandContext,
  loaded: CliApplication,
  profile?: string,
): Promise<AssembledApplication> =>
  applicationOf(
    loaded.application,
    { profile, profileRoot: context.io.cwd },
    `agboss ${context.command}`,
  );

/** The assembled workflow a start opens (the application assembles every one it runs). */
export function workflowOfStart(
  assembled: AssembledApplication,
  start: ApplicationStart,
): AssembledWorkflow {
  const found = assembled.workflows.find((workflow) => workflow.config.name === start.workflow);
  if (found === undefined)
    throw new Error(`${start.workflow} is not assembled in ${assembled.name}`);
  return found;
}

/** The `--env` environment of the assembled application, resolved against the CLI's process env. */
export const applicationEnvironment = (
  context: CommandContext,
  assembled: AssembledApplication,
): Promise<Environment | undefined> =>
  environmentFor(environmentOwnerOf(assembled), { env: envOption(context) }, context.io.env);
