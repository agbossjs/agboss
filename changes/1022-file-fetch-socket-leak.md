---
section: Fixed
issue: 1022
---

**A refused file request no longer leaves its TLS connection open** (#1022, after #916): when the
`ClientRequest` could not be built (a replaced `ClientRequest` that gives the request an
`https.Agent` throws `ERR_INVALID_PROTOCOL`), the TLS socket to the allowed peer stayed connected
and kept the process alive. Every failure after the connection is made now destroys it: the
constructor throwing, a request that has an agent, a request on a socket that is not the module's
own, and the request's `error`. A constructor that throws is refused `a2a.file-address-denied`,
the same as a request that has an agent. Supersedes the "destroyed together with the connection"
sentence of `916-sni`, which did not hold for the throwing case.
