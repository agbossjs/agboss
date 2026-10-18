import type { Class } from "../components/injection.js";
import type { App, ExecutionOptions, ExecutionOutput } from "./types.js";

/**
 * `app.execute` from code that cannot know a workflow's generated types — the CLI, A2A, eval: the
 * input is checked at run time against the start's `input` (an invalid one is `dto.invalid`), as
 * every input is; only the compile-time check is skipped.
 */
export const executeUnchecked = (
  app: Pick<App, "execute">,
  start: Class,
  input: unknown,
  options?: ExecutionOptions,
): Promise<ExecutionOutput> =>
  // the generated `ExecutionInputOf<Start>` is not known here: the run validates the input and the
  // contexts' values itself
  app.execute(start, input as never, ...([options] as [never]));
