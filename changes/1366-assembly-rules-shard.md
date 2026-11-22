---
section: Changed
issue: 1366
---

**The assembly's rules on a price, a limit and a deadline are mutated at 100 %, and none can hide in an unmutated file again** (#1366): a new Stryker shard, `assembly-rules`, mutates whole the files that hold them — a provider's price, timeout and mode rules (`provider-mode-rules.ts`, which the #1385 price check had left in `NON_SHARDED_SRC` under a reason that said it held no spend rule), the application's rule list and its limits, the step and concurrency limits of a flow, the count limits of components and question roles, a question's deadline and working time, the limit handler that may not spend, a tool's expiry and the health check's timers. `maxStepsOf`, the steps limit a run takes, moved into `steps.ts` so that it is mutated with the bound it is held against. `tests/docs/mutation-shard-coverage.test.ts` now also fails a file named in `NON_SHARDED_SRC` that declares or registers a rule on a money or limit code (`*.price-invalid`, `limits.*`, `budget*`), and the reasons of the files left out that hold a limit or a deadline of their own say so.
