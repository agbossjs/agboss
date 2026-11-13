---
section: Changed
issue: 961
---

**The MCP and A2A audience checks are pinned as one rule** (#961): both servers check an
envelope's audience against the application's own name for every app `createApp` or `testWith`
builds, keys or none; a test now holds the MCP gate to the shared check. The only app the MCP gate
skips is a hand-built `App` with no mesh settings, which has no name to address (the A2A listener
refuses to serve it). No behaviour change, no migration. `RELEASE_CHECKLIST.md` now says every car
has a release workflow.
