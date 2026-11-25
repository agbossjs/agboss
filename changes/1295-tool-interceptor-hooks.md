---
section: Breaking
issue: 1295
---

**A tool interceptor decides per tool with `@BeforeTool` / `@AfterTool`** (#1295, part a):
`BeforeToolCall` / `AfterToolCall` and their `beforeToolCall(call)` / `afterToolCall(call)` methods
are gone. A `@ToolInterceptor` class has `@BeforeTool(Tool)` and `@AfterTool(Tool)` methods (one tool,
or several in one decorator: the input is the union, a rewritten input the intersection) that take
the validated input DTO (the output and the input for `@AfterTool`), and plain `beforeAnyTool(call)` /
`afterAnyTool(call)` for every tool. `ToolCallDecision<out TInput = never>` is symmetric:
`allow()`, `allow({ input })` (the arguments the tool gets instead, validated against its input
again), `reply(message)` (was `replyToModel({ message })`), `block(reason)` (was `block({ reason })`).
`ToolCallContext` carries `agent` and `callId`; `ToolCall.typeOf(call)` gives the tool class.
`@Workflow({ excludeToolInterceptors })` removes an application-level interceptor for a workflow.
New rules: `[tool-interceptor.target-not-a-tool]`, `[tool-interceptor.duplicate-hook]`,
`[tool-interceptor.unknown-hook]` (a misspelt or 0.1.0 hook name). `ToolInputOf` / `ToolOutputOf` /
`UnionToIntersection` are exported from the root. `testToolInterceptor` dispatches through the new
hooks and fails with `TestSetupError` for a phase the class has no hook for at all.
