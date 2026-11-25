---
section: Fixed
issue: 1402
---

**An exported `@Tool` called over MCP runs for its session's tenant and owner** (#1402): the call's frame
carried the application's default tenant and no owner, and its execution id (so `step.idempotencyKey`) came
from the client's `_meta.callId` alone, so two tenants sending `callId: "c-1"` got one key. The frame is built
from the session's tenant, owner and execution values, and the execution id is `mcp_` plus a hash of tenant,
caller, tool and `callId`: the same caller repeating a call still gets the same key, no other tenant or caller
can reach it. No migration; a tool that keyed on the old `mcp_<callId>` text sees a different key.
