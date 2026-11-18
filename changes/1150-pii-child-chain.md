---
section: Changed
issue: 1150
---

**A child workflow is masked by its chain's PII policies** (#1150): the application's, the root's,
every ancestor's and its own `@Workflow({ piiPolicies })` mask its models (agents, routers,
rerankers, reply interpreters, compactions) and everything observed of it — spans, logs, events,
its part of `result.record` and of the kept history, its outbound calls and pause notices — on its
parent's instance or any other (a queued child's launch carries its chain's policy names; a name
the worker does not know fails the child). This replaces #120 AC11, under which a value a parent
masked reached its child's models and traces as it is. `excludePiiPolicies` on an agent or a router
may name an ancestor's policy, and the new `@Workflow({ excludePiiPolicies })` removes one at a
child's models — never at observability. Assembly checks exclusions and `[pii.conflicting-rules]`
on every static way into a child; `agboss describe` (`pii chains`) and the start log show each
way's sets. Also fixed: an `AnyInstance` child's spans were masked by its root's policies only, a
root's `result.record` and history masked its children by the root's only, a child's start and end
events went through its parent's mask, and its outbound calls and pause notices through its own
only. Migration: Wiki → Upgrading-to-0.1.1.
