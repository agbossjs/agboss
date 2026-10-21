import type { ApplicationStart } from "agboss/internal";
import { textOption, type CommandContext } from "./context.js";
import { didYouMean } from "./did-you-mean.js";
import { usageError } from "./errors.js";

/**
 * Which start a command runs (#268 AC2): `--start <full name>` — the start's `name`, kind suffix
 * included, the same string as in traces, records and `agboss describe`. With one start in the
 * application it may be omitted; with several and none given the error lists them; a name no start
 * has is an error with a `Did you mean "…"?` hint and the list — nothing runs under a guessed name.
 */

/** `screening-workflow-start (Screens companies; screening-workflow)`. */
const startLabel = (start: ApplicationStart): string =>
  `${start.name} (${start.description}; ${start.workflow})`;

/** The starts as one line: name, description and workflow of each. */
export const startsLine = (starts: readonly ApplicationStart[]): string =>
  starts.map(startLabel).join(", ");

/** The start named `given` (exactly), or the only one when none is given. */
export function chooseStart(
  command: string,
  starts: readonly ApplicationStart[],
  given: string | undefined,
): ApplicationStart {
  const [only, ...others] = starts;
  if (given === undefined) {
    if (only !== undefined && others.length === 0) return only;
    throw usageError(
      command,
      "start.required",
      `The application has ${String(starts.length)} starts: choose one with --start <name> — ${startsLine(starts)}`,
    );
  }
  const found = starts.find((start) => start.name === given);
  if (found !== undefined) return found;
  const hint = didYouMean(
    given,
    starts.map((start) => start.name),
  );
  throw usageError(
    command,
    "start.not-found",
    `Start "${given}" not found.${hint} The starts: ${startsLine(starts)}`,
  );
}

/** `--start <name>` of the command, chosen among the application's starts. */
export const startOf = (
  context: CommandContext,
  starts: readonly ApplicationStart[],
): ApplicationStart => chooseStart(context.command, starts, textOption(context.values, "start"));
