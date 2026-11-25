---
section: Breaking
issue: 1294
---

**A tool's method is `execute`, and `@BindTool` is gone** (#1294): `ToolHandler<TInput, TOutput>` now
has `execute(input): TOutput | Promise<TOutput>` in place of `run(input): Promise<TOutput>`, so a
synchronous tool no longer wraps its result in `Promise.resolve`. A tool class needs no
`implements ToolHandler<…>`: `@Tool({ input, output })` and `@McpTool` check the method against the
DTOs on the decorator line. `testTool`, `toolOf`, `mockTool`, `callTool` and the `agboss generate`
tool scaffolds follow. The duplicate `ToolHandler<TSelf>` in the flow handlers and the dead
`@BindTool`, `BindToolOptions`, `BoundToolConfig` and `getBoundTools` are removed. A tool's `name`
stays what it is: it is the function name the model sees.
