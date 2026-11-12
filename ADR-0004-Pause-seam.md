# ADR-0004 — Pause in projects, seam in the core

- **Status:** Accepted
- **Issue:** #32 (epic #26)

## Context

The core ends a run at a terminal node; a follow-up is a new run in the thread. Some projects need
a human to approve actions (write tools) mid-run. Added ad hoc, `interrupt` would conflict with
spend recording while streaming, budgets and Turns.

## Decision

- The core ships an explicit, optional **pause seam** (`RunDeps.pause`: checkpointer +
  `needsApproval`), off by default, and `resumeAgent`.
- The pause happens at the graph level (`approval` node), not inside the agent loop: the call is
  held, the agent node ends normally, then `interrupt`. This keeps all spend before the pause in
  state and in the ledger.
- Five consistency rules (ledger, budget, Turn, limits, rejection) are specified and proven with
  LangGraph's `MemorySaver`; durable checkpointers and the approval channel stay in projects.

## Consequences

- Adding approval to a project is configuration, not core changes.
- The agent runs again after a decision; tools must be safe to see a stored result for an identical
  call (they are not executed twice).
