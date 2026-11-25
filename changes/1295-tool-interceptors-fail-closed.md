---
section: Breaking
issue: 1295
---

**Tool interceptors fail closed** (#1295, security fix): a call of a tool that resolves to no
`@Tool` class still meets the catch-all `beforeAnyTool` / `afterAnyTool` of its agent's interceptors,
and an agent with interceptors that lists a non-tool class in `tools` is
`[tool-interceptor.unresolved-tool]`; tool classes are resolved per agent, so two agents with
same-named tools get their own hooks; a subclass `@BeforeTool` / `@AfterTool` method that drops a
target of the parent's same-named method is `[tool-interceptor.override-drops-target]`.
