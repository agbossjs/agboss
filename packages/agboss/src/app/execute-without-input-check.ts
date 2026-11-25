import type { Class } from "../components/injection.js";
import type { AnyTenantApp, ExecutionOptions, ExecutionOutput } from "./types.js";

/**
 * `app.execute` from code that cannot know a workflow's generated types — the CLI, A2A, eval —
 * without the compile-time check of the input: the input is still checked at run time against the
 * start's `input` (an invalid one is `validation.dto-invalid`), as every input is.
 */
export const executeWithoutInputCheck = (
  app: Pick<AnyTenantApp, "execute">,
  start: Class,
  input: unknown,
  options?: ExecutionOptions,
): Promise<ExecutionOutput> =>
  // the generated `ExecutionInputOf<Start>` is not known here: the run validates the input and the
  // contexts' values itself
  app.execute(start, input as never, ...([options] as [never]));
