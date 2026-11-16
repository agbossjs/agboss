---
section: Fixed
issue: 1225
---

**Six test files no longer time out in a full gate** (#1225, #1214): `idempotency-key-rotation`,
`lease-skew`, `writes-window-takeover` and `compensation-unwind` carry a 60 s case bound (they ran
5.7-11 s against vitest's 5 s default beside other gates, and 0.6-3 s alone); the `docs/skills` bound
is 300 s (147 s in a full gate, 19-25 s alone); and the published-0.1.0 install fixture removes its
folder asynchronously under a 120 s hook bound (the synchronous removal of the install ran past the
10 s hook default). The global timeouts are unchanged.
