# ADR-0028 — Failures cross instances as their records

- **Status:** Accepted (#598)
- **Issue:** #598 (part of #479; found while fixing #596)

## Context

`.onError(E, …)` picks a side path by the failure's class line: the `static code` of the error's
class and of each class above it, else the class name, through the cause chain (`errorRecordOf`,
`errorHandlerOf`). A child's failure that crossed a takeover or an instance was rebuilt from what
was stored with it: its name and message (the claim of #596, the undo's mark of #340) or names,
codes and messages (an `AnyInstance` child's queue row, `RemoteChildFailure`). None of these held
the class line. A parent's side path on the child's own `PaymentDeclinedError` was taken on the
instance that saw the failure and not on the one that took the tree over, and for a remote child
never. Two holders of one payment took two paths.

## Options

1. **Rehydrate registered classes by a stable name**: the project registers its error classes,
   and a rebuilt failure is an instance of the class again. Each holder needs the same registry. An
   unregistered class still routes apart, so it has to be refused or warned about at assembly.
2. **Persist the side-path decision with the claim**: the routing is not repeated, it is read back.
   This covers the claim only. An undo's mark and a queue row are read by code that routes on its
   own, so each needs its own decision record.
3. **Persist the record routing reads**: the error's class line by code, its message and causes,
   and route the rebuilt failure by that record.

## Decision

Option 3. Routing never looked at the class object, only at the record of its code line, so the
record is what makes the decision durable. Every store that carries a failure across a takeover or
an instance keeps `errorRecordOf(error)` without `details` (`durableErrorOf`, JSON): the claim, the
undo's marks (a root's and a child's), the remote child's queue row. The reader rebuilds a
`RecordedError`, whose `errorRecordOf` is that record. `.onError` then routes it as the instance
that saw the original did. The record is made the same way everywhere: at most 32 causes deep, a
looping chain cut at its first repeat, and a rebuilt cause cut to the depth left under its wrapper.
So the record on the first holder and the one rebuilt on the next have the same depth and the same
codes. A rebuilt budget's or failed undo's error still passes a child's boundary as it is, by its
code (`isRecordedAs`), as the live one does by its class. A cancel is rebuilt as
`ExecutionCancelledError`, since the runtime tests it by class.

What has no record (a mark or a row written before 0.1.1, or a broken value) is rebuilt as before,
on every instance alike: an `AGBossError` with the message, or `RemoteChildFailure`s. Neither
matches a project class. Nothing routes "the class on one holder, a plain error on the other".

## Consequences

- No registry, no new assembly rule, no public API: `errorRecordOf` stays the one way a failure is
  read for routing.
- A rebuilt failure is not an `instanceof` the project's class. A project routes on classes and
  never tests them in a step. Its `details` stay with the original (checkpoint and records), not in
  the marks and rows.
- A class without a `static code` is identified by its name. Two builds that minify names
  differently route apart, so give a class a side path routes a `static code`.
- A remote child's exhausted budget or failed undo now passes its parent's boundary as it is, as a
  local child's does (before, it was wrapped in `ChildExecutionFailedError`).
