---
section: Breaking
issue: 1328
---

**`HoldPoints.reach({ point, phase, key?, signal? })` takes one options bag** (#1328, part e): the four positional arguments of `reach(point, phase, key, signal)` are fields of one object, `key` and `signal` optional. A project's own `*.fault-stores` that reach a hold point change their calls the same way. Added: `HoldReach`.
