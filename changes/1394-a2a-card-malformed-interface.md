---
section: Fixed
issue: 1394
---

**A remote A2A card with a malformed interface entry is refused, not a TypeError** (#1394): a card
whose `supportedInterfaces` holds a `null`, a non-record, or an entry without a string `url` or
`protocolVersion` is refused with `A2AError.Protocol` (fail closed, no card text in the message)
instead of crashing the client with a raw `TypeError`.
