---
section: Breaking
issue: 1324
---

**The generated types are the namespace `AGBossTypes`, and every component class is branded `{ name, kind }`** (#1324g): `.agboss/types.d.ts` fills `AGBossTypes.Inputs`, `.Outputs`, `.ProducerOutputs`, `.WorkflowStarts`, `.Routes`, `.RouterAnswers`, `.ChannelRoles`, `.PauseTargets`, `.AgentTools` and `.DtoBrands`, and the root exports `AGBossTypes` instead of those names (`Inputs`, `Outputs`, `ProducerOutputs`, `WorkflowStarts`, `Routes`, `RouterAnswers`, `ChannelRoles`, `PauseTargets`, `AgentTools`, `DtoBrands` are removed). `[agbossComponent]` carries `{ name, kind }` (`kind` is the flow component's `ComponentKind`); `NameOf` and `KindOf` read it off an instance or a class (`InstanceOrSelf`), so a component's kind no longer comes from its name's suffix — `KindOfName` is removed. `agboss check` types every decorated class under `src/` — a component no workflow reaches (under test), a tool-only application's — and skips tests, declarations, `scripts/` and `bin/`; a class that needs a type no module exports is left out of the tables, not a failure.
