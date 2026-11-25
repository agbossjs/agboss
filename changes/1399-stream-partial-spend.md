---
section: Fixed
issue: 1399
---

**A model stream that fails mid-way charges what it used** (#1399): the provider bills the tokens
it produced before it failed, and a budget under-counted them. The partial usage is now a record of
the call: the usage the stream's `result` settled with after the failure, else the usage counted from
the chunks that came (about 4 characters a token, the prompt's size the request's), with its cost
(the provider's, else the price table's; one that cannot be priced is `CostSource.Unpriced` tokens,
never dropped). It is counted in every budget at once, as a completed call's is, and carried to the
ledger by the failed agent step; the error stays the stream's own failure.
