---
section: Breaking
issue: 1318
---

**Profile shelves for memories and pause targets, and a workflow's `memory` is a class slot** (#1318, part 1318c).

- `memories: { "<memory name>": { ttl, uncompactedTurns, turnsBetweenCompactions } }` in a profile: the thread's keep
  time (`threadTtl`, the sweep), every reader's window, the config defaults and the compaction pace all read the
  profile's values; `ttl` is milliseconds above 0 or `"forever"` in YAML. A memory no workflow reads is a
  `ProfileError`; the declared `@Memory` class is never changed.
- `toolApprovals` and `externalTasks`: `{ "<target name>": { timeout, remindBefore } }` (a duration of at least one
  second, or working time in a `.config.ts`). The pause's deadline, the channel's entry and `agboss describe` read
  the profile's value; a name that is not a target of that kind used in the application is a `ProfileError`.
- `workflows: { "<workflow>": { memory: AClass } }` in a `.config.ts` gives the workflow a `@Memory` in place of its
  `@Workflow({ memory })`: its readers' windows, thread keep time and config follow.
