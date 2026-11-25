---
section: Breaking
issue: 1284
---

**`.joinQuorumGroups({ deadline })` and `.onGroup([targets], options?, subPath)` replace `group(…).priority(n)`**
(#1284). The deadline is the join's own option, written where the join is; `.onError(E, …)` follows the
join as for every join and stands right after it — before the first group, never after an
`.onGroup(…)`: the type system (`GroupsJoining` has `.onError`, `GroupsJoined` does not) and the untyped
builder (`ConfigError.FlowSyntax`) refuse the other order. Each group is one `.onGroup([A, B], { priority }, subPath)`:
`targets` are classes of the launch (`@Agent`, `@ExternalTask`, `@Action`, `@Workflow`; a repeat is one more
copy), `{ priority }` is optional (1 is the highest; none — equal), `subPath` starts with any side-path
starter (`toAgent`, `toAction`, `toRouter`, `toExternalTask`, `toWorkflow`, `toFinish`, `inParallel`,
`forEachItem`). The join is not a `BuiltPath` until it has one `.onGroup(…)`; the untyped builder's version
of that is `[graph.dead-end]`. Open undoable actions are scoped per group: the edge of a group opens only that
group's targets (`compensation-walk`). `QuorumGroupRecord.agents` is `targets` (`ExecutionOutput.launches[i].group`,
`QuorumDecidedEvent.group`, the stored record, `describe`'s `groups[].targets`); a 0.1.0 record's `agents` is
not read. New: `QuorumGroupOptions`, `GroupsJoining`, `OnGroup`, `QuorumGroup.targets`,
`RuntimeGroup.targets`, `JoinGroupOrigin.targets`. Removed: `group(…)`, `.priority(n)`, `GroupStart`,
`GroupPath`, `GroupArguments`, `GroupCheck`, `GroupsCheck`, `GroupHead`, `IsGroupPath`, `groupFrom`,
`QuorumGroup.agents`, `QuorumGroupRecord.agents`.

Store follow-up: a store that persists an execution's `launches` keeps `group.targets` where it kept
`group.agents` (the stored shape is the core's `LaunchRecord`; the stores read it with the core's schema).
