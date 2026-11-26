---
section: Changed
issue: 1324
---

**`@Application({ environment })` is optional** (#1324, part b prep) — an application with no settings omits it and needs no environment file; an omitted `environment` is read as `EmptyEnvironment`, the contract without fields, so an application behaves exactly as one that declared it (the environment named `dev` / `test` is `{}`, a missing field names `EmptyEnvironment`). `EmptyEnvironment` stays exported until the flip.
