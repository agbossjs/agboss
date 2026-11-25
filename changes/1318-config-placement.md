---
section: Breaking
issue: 1318
---

**`workflows.<name>.placement` of a profile** (#1318, part 1318c).

- `workflows: { "<child workflow>": { placement: any-worker } }` (also under `"*"`) in a `defineConfig` / `.config.yaml`
  profile changes where a child workflow runs over its `@Workflow({ placement })` and the application's default.
  Every reader asks the one carrier of the components' options (`ComponentOptions.placements`): the runtime graph's
  child nodes, the launch registry (where a tree keeps its slots), the isolated-worker rules and the isolated-storage
  choice, and the assembly warnings. The declared `@Workflow` is never changed.
- Removed: `placementOfWorkflow(workflow, default)` is now `placementOfWorkflow(workflow, default, placements)`;
  `treeLaunchesQueued`, `isolatedChildrenOf`, `isolatedWorkerViolations` and `withIsolatedStorage` take the placements.
- Not done here: `@Workflow({ historyTtl, executionLimits })` does not exist on the branch yet (1318c-dsl, lane A), so
  those two workflow overlays are not wired.
