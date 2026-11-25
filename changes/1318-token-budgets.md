---
section: Breaking
issue: 1318
---

**Budgets limit dollars and tokens, and one `@Budget` serves many workflows** (#1318): `@Budget({ maxSpend, maxTokens,
description })` declares its limits (constants or `defineEnv` values, `env.usd` / `env.integer`), or the class has
`limit(): BudgetLimit | Promise<BudgetLimit>` (`{ maxSpend?, maxTokens? }`); `[budget.missing-limit]` and
`[budget.conflicting-limit]` check that a budget limits something in exactly one place. `@Workflow({ budget })` attaches a
budget (found without being listed in `@Application({ budgets })`): an execution-scope one is the workflow's own, a
tenant or application one counts beside the application's. A budget's counter is keyed by the budget's name, the scope key
and the period, never by a workflow: five workflows that attach one budget share one cap. Both caps are enforced and each
fails closed; an amount or a count that is no number is refused before the first step. `BudgetExceededError` and
`LimitError.Budget` carry `unit` (`BudgetUnit.Usd | Tokens`), `maxSpend?`, `spent`, `maxTokens?` and `usedTokens`.
A `$0` call with tokens (an unpriced CLI or local model) is written to the ledger, waited for before a checkpoint and
counted by `maxTokens`. `[budget.tenant-budget-required]` applies only to an application with a `tenantContext`.
`CostLedgerRepository` changes: `findUsageByCounter(counter): Promise<BudgetUsage>` (`{ spent, tokens }`) replaces
`findSpentByCounter`, `findLimitByAccount` / `saveLimit` (`BudgetLimit`) replace `findMaxSpendByAccount` /
`saveMaxSpend`, `saveAll` adds each entry's tokens once by its `ledgerId`, and a prune never touches a counter's tokens;
an entry whose tokens are no count is refused (`cost-ledger.entry-invalid`). The mesh claim is `budget: { remaining?,
currency?, remainingTokens? }` and the signed run report carries `spend.totalTokens`, charged to the caller's token budgets
even when the remote run cost nothing; `A2ATaskStatus`, `A2ADirectMessageReply` and `DurableExecutionState.Finished` carry
`spentTokens`. `SpendRecorder.record({ service, cost, tokens? })` takes tokens.

**Store follow-up:** SQLite `cost_ledger.tokens` and `cost_ledger_max_spend.{max_spend_usd NULL, max_tokens}` are in the
baseline DDL; postgres and mongodb need `agboss_cost_counters.tokens`, `agboss_cost_max_spend.max_tokens` and a nullable
`max_spend_usd` (T2), and `spentTokens` on the A2A task and direct-message rows.
