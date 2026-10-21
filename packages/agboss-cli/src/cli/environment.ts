import { textOption, type CommandContext } from "./context.js";

/** `--env <name>`; undefined = the default (`dev`, of an application that declares an environment). */
export const envOption = (context: CommandContext): string | undefined =>
  textOption(context.values, "env");
