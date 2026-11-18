---
section: Security
issue: 1150
---

**A policy a child inherits is in its root's `configHash`** (#1150, acceptance H): a workflow that
launches another workflow fingerprints the PII policies it hands down — the application's and its
own `@Workflow({ piiPolicies })`, as declared — under `handedDown`, also when it has no agent or
router of its own. Before, a policy that reached a child's models only by inheritance was in no
hash when the workflow listing it had no element of its own (an orchestrator root): a deploy that
switched it from `PiiFileAction.Mask` to `AllowOriginal`, or changed its rules, resumed a tree
paused inside the child without `IncompatibleResumeError`. A child's own hash still covers only
what it declares. **Hashes change once** for workflows that launch a child and whose application or
own `@Workflow` lists a policy: their paused or running trees resume only where
`onIncompatibleResume` accepts it (Wiki → Upgrading-to-0.1.1); every other workflow keeps its hash.
