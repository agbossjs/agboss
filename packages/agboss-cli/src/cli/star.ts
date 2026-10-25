import { inspect } from "node:util";

/** The one line an interactive `agboss` call ends with, on stderr. */
export const STAR_LINE =
  "⭐ Like AGBoss? Star us on GitHub: https://github.com/agbossjs/agboss";

/** `AGBOSS_NO_STAR=1` turns the line off. */
export const NO_STAR_ENV = "AGBOSS_NO_STAR";

/** Flags that mean a machine or a script reads the output. */
const MACHINE_FLAGS: ReadonlySet<string> = new Set(["--json", "--quiet"]);

/** What tells an interactive call from a scripted one. */
export interface StarContext {
  /** Whether stderr is a terminal (undefined when it is not). */
  readonly isTTY?: boolean;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  /** The command line after `agboss`. */
  readonly argv: readonly string[];
}

/** Where the line goes: stderr. */
export interface StarOutput {
  readonly write: (text: string) => unknown;
}

/** How a command ended: on its own (its exit code stands) or by throwing. */
export type CommandEnd = "completed" | "threw";

const isSet = (value: string | undefined): boolean => value !== undefined && value !== "";

/** True only for an interactive call: a terminal, no CI, no machine flags, not turned off. */
export function shouldShowStar(context: StarContext): boolean {
  return (
    context.isTTY === true &&
    !isSet(context.env.CI) &&
    context.env[NO_STAR_ENV] !== "1" &&
    !context.argv.some((arg) => MACHINE_FLAGS.has(arg))
  );
}

export function printStar(out: StarOutput): void {
  out.write(`${STAR_LINE}\n`);
}

/** Runs a command, then the star line when due — also after a failure, whose error is written first. */
export async function runWithStar(
  command: () => Promise<void>,
  context: StarContext,
  out: StarOutput,
): Promise<CommandEnd> {
  try {
    await command();
    return "completed";
  } catch (error) {
    out.write(`${inspect(error)}\n`); // as Node prints an uncaught error
    return "threw";
  } finally {
    if (shouldShowStar(context)) printStar(out);
  }
}
