---
section: Fixed
issue: 1382
---

**An A2A contract price that is no amount can no longer inflate a charge or throw after the peer accepted** (#1382) —
`@A2AAgent({ price })` and `A2AClient({ contract: { price } })` are typed `Usd`, but a price from untyped code, a config file or
JSON was used as it came: a negative price was not charged at the accept and the settle added its size (a $3 report with a price
of -1 was charged $4), and a `NaN` or `Infinity` price threw `UnitError` only after the peer had accepted the task. Assembly now
refuses an `@A2AAgent` price that is not a finite number of dollars from 0 with `[a2a.price-invalid]`, and a client built with such
a `contract` refuses its call with a `ConfigError.Component` `[a2a.price-invalid]` before the card is read, anything is sent, accepted or
charged. The charge itself (`chargeOf`, the accept's and the settle's) throws a `UnitError` for a price or an already-charged
amount that is no amount, never a number. The messages name the value's kind, never its text. The same hole in a sibling:
`ModelCost.fromPrices({ … })` refuses a model price (input, output, cached input) that is negative, `NaN` or `Infinity` when the table
is made, naming the model and the field. Prices a peer or a config file supplies were already safe and are now tested: a peer's
signed report with a total that is no amount counts as the price alone, a config `price` of `NaN`, `Infinity` or a negative number
fails `validateAgentsConfig`, a tool's or a provider's reported cost that is no amount throws.

- **Existing project:** an `@A2AAgent` or `contract` price that is negative or not finite now fails assembly or the call; use
  `usd(...)` of a finite amount from 0, or leave `price` out. A `ModelCost.fromPrices` table with such a price fails when it is built.
