---
section: Fixed
issue: 1037
---

**The `LatestByStep` contract cases put valid LangGraph checkpoints** (#1037, a follow-up of #962):
the published cases (`checkpointSaverContract` with `StoreCapability.LatestByStep`) put a channel
value without a version, so a saver that keeps a channel's value only as a blob of a version listed
in `newVersions` (LangGraph's `PostgresSaver`) returned `{}` and failed two of the five. The cases
now put the marker as a channel with its own version (`channel_versions` and `newVersions`), so any
`BaseCheckpointSaver` that follows LangGraph's blob semantics can declare the capability. The
concurrent case stops its writer and awaits it when a read fails, instead of leaving it running
(an unhandled rejection from a closed pool), and ends with the writer's error when the writer fails.
