---
section: Security
issue: 1138
---

**A file fetch by url touches only the allowed peer, even on another agent** (#1138, after #916):
a replaced `http.ClientRequest` that put a refused request on a keep-alive agent — one that drops
`createConnection` (Node then falls back to `http.globalAgent`) or assigns `http.globalAgent` —
let that agent make its own, unguarded DNS lookup and a TCP connection to whatever it answered (a
rebound `127.0.0.1` port got one connection, 0 bytes), and the refused request's socket went back
to the agent's pool, still connecting, which kept the process alive. The request is now made on
the fetch's own agent, which hands it the one connection already checked; another agent is given
the checked address as its host, a lookup that answers only that address and a `localAddress`
that `net.connect` refuses before it connects, so it makes no lookup and no connection; one that
strips those options too connects at most once more, to the checked address, and its socket is
destroyed as it is assigned, never pooled. The limit that stays: a replacement that also sets the
url's name back makes one more DNS lookup, but no connection. A request that fails twice (its TLS
socket destroyed after an error) no longer crashes the process with an unhandled `error`.
