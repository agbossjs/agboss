---
section: Security
issue: 1138
---

**A file fetch by url makes one TCP connection, to the vetted address only — never through
`node:http(s)`** (#1138, after #916): a replaced `http.ClientRequest` that put the request on a
keep-alive agent — one that drops `createConnection` (Node then falls back to `http.globalAgent`),
assigns `http.globalAgent`, or sets the url's name back — let that agent make its own DNS lookup
and a TCP connection to whatever it answered: a rebound `127.0.0.1` port got one connection
(0 bytes), at first through the pool, and still after the first fix whenever the resolver answered
within the same tick (an in-memory cache, a stub). The fetch now constructs no `ClientRequest` and
no agent at all: it resolves the name once with the guarded resolver (every answer checked, one
denied address refuses the name), connects a raw socket to the vetted address with a `lookup` that
answers only that address (a `net.connect` wrapper that puts the name back makes no lookup of its
own), checks the socket's remote address at `connect` before any byte, starts TLS on it (SNI and the
certificate for the host), and writes its own HTTP/1.1 `GET` on it (`Connection: close`; the
response read strictly — the status line, the headers, a `chunked`, `Content-Length` or
close-delimited body), so nothing a replacement of `ClientRequest`, an agent or an interceptor does
is ever asked, and nothing is pooled or reused. A redirect hop goes through the same steps. What
stays outside: a patch of `net` or `tls` itself — one that connects elsewhere is refused at the peer
check with nothing sent, one that lies about `remoteAddress` cannot be detected — and `ClientRequest`
wrappers (APM) no longer see the request (the fetch's own span stands for it, #1021).
