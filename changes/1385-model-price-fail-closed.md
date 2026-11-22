---
section: Fixed
issue: 1385
---

**A model price that is no amount from 0 can no longer lower a recorded cost, however the table was made or changed** (#1385) —
#1382 checked a price table only inside `ModelCost.fromPrices`, but `ModelCost` is a public union: a literal
`{ kind: "from-prices", prices: { m: { inputPerMillion: -5, outputPerMillion: 1 } } }` type-checks, never passed that check, and
was costed as it came (100 input and 1000 output tokens recorded $0.0005 instead of $0.0015). `fromPrices` also froze its table
shallowly, so each entry stayed the caller's own object and could be set negative afterwards. Now a price is checked wherever it
enters or is used: `ModelCost.fromPrices` refuses a price that is not a finite number of dollars from 0 (input and output are
required, cached input is optional) and keeps its own frozen copy of every entry; assembly refuses a listed provider's (or a breaker
fallback's) literal table with `[model.price-invalid]`; `priceOf` checks the entry it returns, so a table changed after it was made
throws a `UnitError` `[model.price-invalid]` before any cost is computed; and the cost of a call (`costOf`, which every price
reaches: a config `price`, a provider's table, a fallback's) throws a `ModelCostError` for a price field that is no amount, so a
negative price can never offset a positive one. A model named like `Object.prototype` members (`constructor`) has no price. The
messages name the field and the value's kind or number, never the model or any text; `ModelCost.fromPrices` no longer names the
model either. A provider's `fromResponse()` cost and a config `price` (zod) were already checked.

- **Existing project:** a `ModelCost` literal or a `fromPrices` table with a negative, `NaN` or `Infinity` price, or one without an
  input or an output price, now fails assembly or the call; give every model `usd(...)` of an amount from 0.
