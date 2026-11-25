---
section: Breaking
issue: 1271
---

**A `@Router` route's `target` is a class or a thunk of one** (#1271b): `{ target: () => NoOrderWorkflowFinish }` names a class declared below the router (or in a module that imports the router back) without the temporal dead zone. The thunk is read at assembly and at run time, once every module has run; `Route<R>` and the generated `Routes` / `RouterAnswers` tables list the classes. `routesOf(options)` is the one reader of a router's routes; the shared `resolveTarget` / `TargetRef` / `UnwrapTarget` (#1287, #1318 take them too) are internal.
