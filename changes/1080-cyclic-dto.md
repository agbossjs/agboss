---
section: Fixed
issue: 1080
---

**A DTO that holds itself is a start error, not a stack overflow** (#1080): a DTO graph with a cycle (a DTO referencing itself through `@Nested` or `@ListOf`, directly or via other DTOs) crashed `createApp` with a raw `RangeError: Maximum call stack size exceeded` while the answer-tool JSON schema was built. Now every component of a workflow (agent, action, router, start, finish, question) whose input or output DTO graph has a cycle fails the start rules with `[dto.cyclic]`, naming the component and the cycle (`reader-agent: PingDto → PongDto → PingDto`); a tool's DTOs, and any other DTO walk (runtime validation, JSON Schema, A2A, MCP), fail with a `DtoError` `dto.cyclic` naming the cycle. A DTO used twice (not a cycle) and a deep finite nesting are unaffected. Recursive schemas are not supported: break the cycle with an id field or a flat list. No migration.
