---
section: Breaking
issue: 1328
---

**Fault and contract helpers: `ClockSkew.None`, `StoreHoldPoint.PauseSetTimeout`, a `Date` payment time** (#1328): `ClockSkew.none` is `ClockSkew.None`; `StoreHoldPoint.PauseExtend` (`"pause.extend"`) is `StoreHoldPoint.PauseSetTimeout` (`"pause.setTimeout"`); `FakeGatewayPayment.madeAt` is a `Date`, not epoch milliseconds.
