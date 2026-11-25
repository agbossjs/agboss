---
section: Fixed
issue: 1394
---

**A remote agent card is untrusted input, read with bounds** (#1394, #1396, #1397): `A2AClient` refuses with
`A2AProtocolError` (fail closed, nothing sent, none of the card's text in the error) a card whose
interfaces, `skills`, `capabilities`, extensions or an interface's `tenant` are not shaped as a card, or
that the SDK's own reader cannot read — never a `TypeError`. The card body is read as a stream and cut off
at 1 MB (a declared length over it is refused unread), a card lists at most 100 interfaces, and the
interface filter keeps the usable entries themselves in linear time (an interface of a binding the client
does not speak is not in the checked card, even on a usable URL).
