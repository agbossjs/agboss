# ADR-0022 — Child workflows as runs of their own

- **Status:** Accepted (#333 S3, S4) — reverses #263 S24; implemented in #333 PR 1–4
- **Issue:** #333 (the epic); #360 (cross-instance cancel, its PR 0)

## Context

A child workflow (#263) — `.toWorkflow(W)`, `route(W)`, `.toParallelWorkflows(W, …)`, `ThisWorkflow`
(#264) — runs today as a **subgraph on its parent's checkpoint thread** (#263 S24): the parent's node
streams the child's compiled graph under the launching task's `checkpoint_ns`; the child's state,
identity and pauses live in the parent's checkpoints, and one lease (#265) covers the whole tree.

So a whole tree runs on the one instance that holds its lease. A fan-out of heavy children — or a
deep recursion — cannot use the other instances that share the same stores, however idle they are.
A child cannot be claimed elsewhere because it has no place of its own: no thread, no identity
outside its parent's checkpoint, nothing another instance can continue.

## Decision

**Every child execution is a run of its own.**

- **Its own checkpoint thread** on the application's checkpointer:
  `<parentThreadId>/child/<childExecutionId>` (S4 D3). The child's graph runs as a root graph —
  outside its parent's LangGraph run (its namespace, its task, its resume map) — so its
  checkpoints, interrupts and resumes are its own. A child thread is never a thread of the API: it
  is not listed, `execute` / `cancel` / history never address it, and `records export` keeps
  children nested under their root.
- **Its identity is found by its launching task**: the parent's task (`checkpoint_ns`) maps to the
  child's identity once, on its first entry; a re-entry after a pause or a crash reads it back — the
  same id, no second `onExecutionStart`.
- **Waiting is the drain's (Q3, #267 S35 / Q58), only when it must (S4 D2, the hybrid).** A child
  placed on its parent's instance (`ChildPlacement.ParentInstance`, the default) is awaited inside
  its parent's step, as today: it ends there — its value, or its failure — and the parent goes on in
  the same pass, with the same budget tally, tree slots, `FailFast` aborts, undo boundary (#340) and
  events. Only a child that cannot end within the step makes the parent's node interrupt with a
  **waiting marker** naming the child: a child that rests paused (PR 1), or one placed on another
  instance (`ChildPlacement.AnyInstance`, PR 2). The tree rests as it does for any pause; its
  pending pauses are read through the markers (`result.pending` unchanged); a resume is still one
  command for the tree, which the parent's node forwards to the child's thread; the child's end
  lets the parent go on.
- **Studio is unchanged (S4 D5):** the child's compiled graph stays registered as its node's
  subgraph, for drawing only; no execution runs under it.
- **Placement is per launch (Q2):** `placement: ChildPlacement.AnyInstance` on `.toWorkflow(W)` /
  `.toParallelWorkflows(W, …)` (PR 2); never automatic, never application-wide.
- **Tree-wide guarantees hold across instances** (PR 2–4): queued children are claimed atomically
  (`ChildExecutionQueueRepository`, in-memory + SQLite) by instances with free step slots (#332);
  the tree's `maxConcurrentExecutions` lives in `RateLimitRepository` (slots as leases); depth and
  the root's budgets are checked where the child runs; spend reaches the ledger at once; PII tokens
  go back to the parent with the child's end.
- **Recovery:** until PR 4 the recovery sweep continues roots only (S4 D4) — a child is continued
  by its root's re-run, from its own thread's last checkpoint; PR 4 recovers a child on its own.
- **Upgrade (S4 D6):** for one version, a child found at its old place — a subgraph checkpoint under
  the launching task's `checkpoint_ns` on its parent's thread — is continued the old way to its end.

## Consequences

- A tree can spread over instances, launch by launch, without changing what a workflow means: a
  child still inherits its parent's thread owner, tenant, contexts and budgets, and gives back its
  value, its PII tokens and its record.
- Children have state of their own that other instances can read: the checkpoint of a child is no
  longer found under its parent's namespace — code that reads children's checkpoints (pending
  pauses, undo records, recovery) follows the child's thread instead.
- A local child that pauses costs one more interrupt (its parent's marker); one that ends in its
  step costs nothing more than today.
- The mechanism of a remote child is the one of a pause (Q3): no new scheduler; the drain already
  takes what was resolved meanwhile before a tree rests.
- Watch: the waiting marker must never reach a channel, `result.pending` or the pause history; a
  child thread must never be addressable as a thread.
