---
section: Changed
issue: 1366
---

**The assembly's price check reaches every `@A2AAgent` that an application, a workflow, a child workflow or a token provider (`provide(TOKEN, Agent)`) lists, and the choice of those agents is mutated** (#1366): `providersOf` and `isClass` of `a2a-rules.ts` are no longer left out of the `ledger-a2a-client` shard, with a test that an agent with a bad price is refused at `[a2a.price-invalid]` from each place. An `@A2AAgent` given for a token is now checked at assembly too, as one that is listed is. The suppression check counts `as never as` in tests like `as unknown as` (budget 0), and the tests that used it build typed fixtures. The stale `rag.ts` proven-hang entry of `ledger-retention` is removed.
