---
section: Added
issue: 1320
---

**MCP `resume_workflow` takes a free-text reply** (#1320, part e): `{ pauseId, decision }` as before, or
`{ pauseId, reply }` — the pause's channel interpreter reads the reply like `app.resume({ pauseId, reply })`;
exactly one of the two (both or neither is an error result). A2A follow-ups already took a text reply or a
`{ pauseId?, decision }` data part. The pending pauses an A2A task shows (`INPUT_REQUIRED` status data part and
the stored status) carry `{ pauseId, kind, input, toolCall? }` instead of `ask` (#1307d). No store change
beyond the A2A status JSON: `@agboss/postgres` and `@agboss/mongodb` keep a status as written (any key), and
the contract cases `a2a-task-status.cases.ts` / `a2a-task-tails.cases.ts` use the new names.
