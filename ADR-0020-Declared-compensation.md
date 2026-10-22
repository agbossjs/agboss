# ADR-0020 — Declared compensation: explicit where a path can say it, automatic where none can

- **Status:** Accepted (replaces the rollback bullet of [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope))
- **Issue:** #339 (the contract and the checks), #340 (the automatic undo)

## Context

ADR-0019 made rollback explicit: `.onError(Err, toAction(UndoAction)…)`, no automatic
compensation, no `compensate` metadata. That keeps every undo reviewed, typed and tested — but it
leaves three gaps:

- Nothing ties an action to its undo, so a new `.onError` side path or an early failure finish
  added later can skip an undo silently — the external system (an ATS, a calendar, a payment) keeps
  a dangling record. `agboss check` and `agboss describe --json` cannot see which action undoes
  which.
- Some stops have no path at all: `app.cancel`, an uncaught step failure, an uncaught limit, a
  `FailFast` sibling child. No side path can be written for them.
- A failed join drops its finished branches' values, so an `.onJoinError` side path cannot undo a
  finished sibling by hand.

## Decision

- An `@Action` declares its undo: `@Action({ compensateWith: UndoAction, committedBy?: CommitAction })`.
  The undo is an ordinary `@Action` (code, never a model call), not undone itself (no chains), and
  reads only what the path holds right after the action. `committedBy` names the action after which
  nothing undoes it; without it, a finish commits it.
- **Explicit where a path can say it**: an `.onError` / `.onJoinError` side path after an open
  undoable action that ends at a finish must run its undo actions, newest first — checked at
  assembly (`[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`); with `committedBy`,
  every path from the action runs the committer or the undo (`[flow.uncommitted-action]`, an error:
  leaving `committedBy` out says "the finish commits").
- **Automatic only where no path can say it** (#340): the execution ends without a finish — a
  cancel, an uncaught failure or limit, an aborted child — or a join fails after some branches
  finished. Then the framework runs the open actions' undo actions itself, newest first, each
  bounded by `compensationTimeout`; a failing undo does not stop the rest, and the execution fails
  with `CompensationFailedError` (the original error as `cause`).
- A child workflow is the unit of work: its finish commits its own actions; an aborted child undoes
  its open ones before its error reaches the parent.
- Rule groups `action.*` and `flow.*`; no `saga.*`, no public name with "saga".

## Consequences

- Easier: an undo is declared once, next to the action, and every side path is proven to run it;
  `agboss describe` shows `compensateWith … · committedBy …` per action; a cancel or an uncaught
  failure no longer leaves side effects behind (#340).
- Harder: one more contract to keep — an undo must be safe to run twice (it gets an idempotency
  key) and read only what was on the path right after its action.
- Out of scope: the side effects of an agent's tool calls (agents get no `compensateWith`), and
  quorums (they launch agents only).
- Rejected: metadata only, without an automatic undo (leaves cancels and uncaught failures with side
  effects); an automatic undo everywhere (implicit, two ways to say one thing); records moving up to
  the root (a parent's side path would undo actions whose inputs are not in its scope).
