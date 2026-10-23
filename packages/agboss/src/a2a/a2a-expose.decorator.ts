import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";

/** `@A2AExpose({ name, version, exports })` (#398 PR 3). */
export interface A2AExposeOptions {
  /** `billing-a2a-expose` — kebab-case, ending with `-a2a-expose` (`[name.kind-suffix]`). */
  readonly name: string;
  /** The contract's version, in `describe --json` and federation checks. */
  readonly version: string;
  /** The workflow starts it serves (`@WorkflowStart` classes of the application's workflows). */
  readonly exports: readonly Class[];
}

/**
 * `@A2AExpose` (#398 PR 3, mirrors `@McpExpose`) — what an application serves over A2A: its name,
 * version and the starts a caller may run. Put it on an empty class, list it in
 * `@Application({ exposes })` and serve it with `a2aHttpListener(app, { expose, callerResolver })`;
 * `agboss describe --json` lists it among the application's exported contracts.
 */
export function A2AExpose(options: A2AExposeOptions) {
  return <C extends Class>(target: C): C => {
    recordComponent(target, { kind: "a2a-expose", meta: options });
    return target;
  };
}
