import { callerFile } from "../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import type { AfterToolCall, BeforeToolCall } from "./decision.js";

/**
 * `@ToolInterceptor` (#384): a cross-cutting check or rewrite of an agent's calls to its `@Tool`s and
 * `@McpTool`s — `beforeToolCall` decides whether the tool runs, `afterToolCall` gives the result
 * the model reads. Listed in `toolInterceptors: [...]` of `@Application` → `@Workflow` → `@Agent`
 * → `@Tool` / `@McpTool` (lists add up, outer first); `excludeToolInterceptors` on an agent or a
 * tool removes an inherited one. Created by the container with its `deps`.
 */

/** What `@ToolInterceptor` recorded: its options and the file it is declared in. */
export interface ToolInterceptorMeta {
  /** Ends with `-tool-interceptor` (`tenant-scope-tool-interceptor`). */
  readonly name: string;
  readonly description: string;
  readonly deps: readonly Token[];
  readonly source?: string;
}

/** A tool interceptor: its class implements `BeforeToolCall`, `AfterToolCall` or both. */
export function ToolInterceptor<const D extends readonly Token[] = []>(options: {
  /** Ends with `-tool-interceptor` (`tenant-scope-tool-interceptor`). */
  readonly name: string;
  readonly description: string;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
}): <C extends new (...args: ResolvedAll<D>) => BeforeToolCall | AfterToolCall>(value: C) => C {
  const source = callerFile();
  return (value) => {
    const meta: ToolInterceptorMeta = {
      name: options.name,
      description: options.description,
      deps: options.deps ?? [],
      ...(source === undefined ? {} : { source }),
    };
    recordComponent(value, { kind: "tool-interceptor", meta });
    return value;
  };
}

/** A class's tool interceptor record, if it is one. */
export const toolInterceptorMetaOf = (cls: Class): ToolInterceptorMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "tool-interceptor" ? component.meta : undefined;
};
