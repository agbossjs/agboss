---
section: Added
issue: 895
---

**`testWith(App, { profile, profileRoot })` runs a workflow under a profile** (#895): the same two
options as `createApp(App, { profile, profileRoot })`, `profiles/<workflow>/<profile>.yaml` under
`profileRoot` (default `process.cwd()`; in a monorepo
`fileURLToPath(new URL("..", import.meta.url))`, never `.pathname`), applied to every workflow of the
application, the child workflows too, with the models scripted. It replaces `withProfile` of
`@agboss/core/internal` in a test. The new read-only `app.settings` (by workflow name) gives what
the profile applied: `app.settings["scout-workflow"]?.agents["scout-agent"]?.thinking`.

- An unknown profile name is a `ProfileError` that lists the profiles that exist (`createApp` and
  `testWith` alike), no longer a bare `ENOENT`.
- A model a profile switches to one no listed provider serves is `[model.unserved]` at assembly, not
  at the first call.
