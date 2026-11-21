---
section: Fixed
issue: 1373
---

**A count limit that is no whole number can no longer turn a budget off** (#1373) — `maxVisits: NaN`, `"five"` or `{}`
(options built from JSON, `Number(process.env.X)` or `parseInt`) counted as a bound in the build analysis, but the run never
applied it: a review loop ran up to `maxSteps`, a paid model call at each visit, with no error. Assembly now refuses it with
`[limits.count-invalid]` (an agent, a router, a question step, and a question role an agent asks as a tool), and the
same for the siblings found with the same hole: `@Workflow({ maxSteps })`, `maxToolCalls` (an agent's and
`defaults.tools.maxToolCalls`) and `maxRetries`. A value that is a whole number from 0 is unchanged; one that got past assembly (untyped code that never
assembled) is a bound of 0 at run time, as `null` is (#1365): the first visit, step, tool call or retry is refused, never
endless ones. A budget's `maxSpend()` that gives no finite amount of dollars from 0 refuses the execution before its first
step with a `UnitError` naming the budget. No message quotes a value's text: a number is printed, anything else by its
kind; `usd(...)`, `seconds(...)` and the other units, and the timers, do the same.

- **Existing project:** a `maxVisits`, `maxToolCalls`, `maxRetries` or `maxSteps` that is a fraction (`1.5`) or a negative
  number now fails assembly (it was read as given); `maxSteps` of `Infinity` too. Use a whole number, or leave the field out.
