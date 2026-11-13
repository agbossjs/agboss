---
section: Fixed
issue: 916
---

**A file fetch holds against a patched HTTP client, and its connected address is re-checked**
(#916, after the acceptance of the above): `global-agent` (and any code that patches
`https.request` and forces its own agent) swapped the fetch's agent for a proxying or unguarded
one, so the guarded lookup never ran. The fetch no longer goes through `https.request`: it builds
a `ClientRequest` with its own agent and refuses unless the request really uses it, and, as soon
as the socket's TCP connection is made, before TLS starts (no ClientHello, which names the host,
and no request byte reach a refused peer), checks the remote address again. A denied address
(embedded IPv4 forms included), an address the guarded lookup did not answer for that connection
(a proxy in the way), or a socket that did not come through the file agent is destroyed and
refused `a2a.file-address-denied`. File fetches bypass any HTTP(S) proxy and global agent.
Patches below the request (a replaced `ClientRequest`, `Agent.prototype.createConnection` /
`addRequest`, `tls.connect`, `net.Socket.prototype.connect`) can still open the TCP connection
to a denied address, which then sends nothing and is closed; they cannot get a byte through it.
Both guards are pinned by child-process tests that go red when either is removed.
