---
section: Breaking
issue: 1281
---

**A child workflow's undoable actions bubble up to its parent** (#1281b, D8): a child's finish no longer commits
its open undoable actions. Its finish moves them up to its parent in the same write (`CompensationEntry.heldBy`),
and the parent's step that ran the child takes them, once by their compensation keys, under the parent's lease
(`CompensationEntry.childPath`: the parent's node of the child, then down; a child workflow's branch is stamped
with its launch and index). The parent's finish commits them; an unwind of the parent undoes them with its own,
newest first, each in the child's own workflow and container: a failed join, a quorum that went on without the
child's branch (`NodeKind.Workflow` branches are undoable, `CompensationReason.QuorumExcluded`), the parent's own
failure or cancel. Grandchildren's go up level by level. A child on any instance carries them in its finished
state, which its parent reads. What the child committed or undid never moves. A parent that fails after a child
finished now undoes the child's open actions, where 0.1.0 had committed them at the child's finish.
