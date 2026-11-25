---
section: Security
issue: 1325
---

**`A2AError.Protocol` keeps only versions in `protocolVersions`** (#1325, #1320): the A2A versions a remote Agent Card declares are filtered (the ones that read as a version, at most five) inside the variant itself, so no text of a remote card reaches the error's fact or its persisted `details`, however the error was constructed. `A2AError.Unavailable.sent` is documented: `false` the request never left, anything else it may have arrived.
