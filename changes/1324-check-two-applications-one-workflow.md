---
section: Fixed
issue: 1324
---

**`agboss check --application` with two `@Application` classes that list one workflow** (#1324): the
workflow's container outside an application took the storage of the one loaded application that
lists it, and with two loaded it took none, so the SQLite repositories failed with "need the
application's `@DatabaseStorage`". An assembled workflow now remembers the application that
assembled it (`AssembledWorkflow.application`) and its storage; a run on its own (`check`, eval,
replay) reads that application's storage, budgets and providers, and looks the application up by
the workflow only for a workflow assembled on its own.
