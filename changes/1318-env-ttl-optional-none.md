---
section: Breaking
issue: 1318
---

**`env.ttl.optional` keeps `Ttl.None` out** (#1318): it takes `allowNone` (default `false`) like `env.ttl`, and is typed `EnvRef<Milliseconds | Ttl.Forever | undefined>` unless `allowNone: true`.
