---
section: Security
issue: 916
---

**A file fetch makes its own connection, and its deadline settles it by itself** (#916, after the
re-acceptance of #932): a file fetch took its connection from `https.Agent`, so a class that
replaced `https.Agent` before the core loaded and added `proxyEnv` made the file agent itself a
tunnelling one: Node sent `CONNECT` for the denied name and a ClientHello through the tunnel
before the request's `socket` event, and, against a target that never answers, the fetch never
ended (the tunnel ignores the abort signal). The fetch no longer has an agent. It resolves the
name with the guarded resolver, connects a raw `net` socket to an allowed address, checks that
socket's remote address before a byte is sent, and only then starts TLS on it and sends the
request. No proxy setting, global agent or `https.Agent` replacement can reach it. The fetch
timeout (and the end of the request) now settle the fetch on their own timer, whatever the
transport does with the abort signal. Pinned by child-process tests that go red on the previous
code (the replaced `https.Agent` class, a silent target) and by sabotage of each guard. (An earlier
version of this entry also said the fetch refuses when `net.connect`, `tls.connect` or
`ClientRequest` is patched; that probe is gone, see 916-sni: the guarantee is the peer check.)
