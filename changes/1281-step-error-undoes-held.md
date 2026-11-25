---
section: Changed
issue: 1281
---

**A failed step's `.onError` undoes what its children held first** (#1281, D8, DSL review 10). When a plain step of a parent fails and an `.onError` edge takes the error, the runtime — before the side path's first node — undoes every open entry its finished children left to this execution (`CompensationReason.StepFailed`): newest first by the tree's durable order, each in its child's own workflow and container, as a failed join does, once across takeovers (the same marks). The parent's own entries stay the side path's to undo (`[flow.uncompensated-action]`), and a child the side path launches commits normally. Before, the side path's finish committed the child's reservations, though the side path cannot name a child's own undo. An undo that fails ends the execution with `CompensationFailedError`, never taken by a side path.
