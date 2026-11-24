---
section: Breaking
issue: 1341
---

**An `Immediate` pause fences the tree's children, and a write that races it parks the holder** (#1341,
part c): a write of a child lease (a `ChildPlacement.AnyWorker` child, on any instance) is refused while
the root's current token is the fenced one — every write of a tree looks at the root's lease row — and
runs once the root's lease is taken again at `token + 1`. A fenced write of the holder, refused before
the holder is told (a pause asked on another instance), is `ExecutionPauseFencedError`
(`execution.paused.fenced`), not `ExecutionError.Fenced`: the holder parks, `app.execute` and
`app.resume` resolve `ExecutionStatus.Paused` with `isExternallyPaused` and never reject with a hand-over.
A claimed child whose tree is paused is parked too (`Immediate` aborts its step at the next look,
`AfterStep` lets it finish and starts none): its row stays `Running` and an unpaused parent has a worker
take it from its checkpoint. A parked tree whose `app.unpause` died after it cleared the mark and before it
marked the record `running` is woken by the recovery sweep's orphan look (by the `paused` status, not through
an open pause). The pause mark now carries its `mode` (`PauseMarks.pause.mode`). Store follow-up: build
`ExecutionPauseFencedError.of(key)` for a write at or under the root's fence, check the root's row for a
child key (`fenced_through_token >= the root's lease_epoch`), the `external_pause_mode` column
(`mode` only escalates while the pause lasts, cleared by `unpause`); contract cases
`execution-lease-pause`, `fenced-effect-pause`.
