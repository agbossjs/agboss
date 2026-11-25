---
section: Breaking
issue: 1318
---

**A profile's budgets reach every run, and a workflow's `budget` is a class slot** (#1318, part 1318c).

- A run of one workflow on its own — eval, replay, golden, `compareProfiles`, studio — counts the budgets of the
  profile it was assembled under, not the declared ones: `AssembledWorkflow.budgetOverlays` carries the limits
  and the attached budgets to the standalone listing, so a limit a profile tightens is enforced the same on
  every path.
- `workflows: { "<workflow>": { budget: AClass } }` in a `.config.ts` attaches a `@Budget` class to the workflow
  in place of its `@Workflow({ budget })`; the `budgets` shelf may then name it. A class that is no `@Budget` is
  refused by `defineConfig` with its path.
