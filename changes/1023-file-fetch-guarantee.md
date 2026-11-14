---
section: Fixed
issue: 1023
---

**The file fetch's guarantee is stated exactly** (#1023, after #916): **0 bytes to a denied peer**
(no TCP payload, no ClientHello, no request). **An allowed peer whose request gets an agent swap
may see a TLS ClientHello, but no HTTP byte.** A wrapper that keeps behaviour unchanged (APM) works,
and one that reroutes the connection is refused with nothing sent. The known limit stays: a `net`
patch that lies about `remoteAddress` cannot be detected. `CLAUDE.md` no longer says the fetch is
refused when `net`, `tls` or `ClientRequest` are patched: that was the stack probe, removed in
`916-sni`; the guarantee is the peer check on the raw socket.
