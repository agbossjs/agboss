---
section: Breaking
issue: 1307
---

**A refused `permitAnswer` is `PauseError.PermissionDenied`** (#1307, conformance) — a `permitAnswer` that returns anything but `true`, throws, rejects or cannot be resolved refuses the answer with `PauseError.PermissionDenied` (`pause.permission-denied`); the pause stays as it was.

- **Changed:** the refusal was `PauseAnswererError` (`pause.wrong-answerer`); that one stays for a wrong credential (`ownerId` / `answeredBy`).
