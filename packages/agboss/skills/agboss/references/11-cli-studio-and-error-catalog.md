# The CLI, Studio and the error catalog

Assembly rules fail with every violation at once, each with its code — `[graph.dead-end]`:

```ts
import { GraphRuleError, type RuleCode } from "agboss";

export const codesOf = (error: unknown): readonly RuleCode[] =>
  error instanceof GraphRuleError ? error.violations.map((violation) => violation.code) : [];
```
