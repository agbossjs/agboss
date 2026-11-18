---
section: Security
issue: 1244
---

**The A2A file fetch's own HTTP/1.1 client is strict where a hostile origin could desync it** (#1244,
the review of #1241): header whitespace is only SP and HTAB, and a control byte in a header, a reason
phrase or a chunk extension is refused; two different `Location` headers, a `Transfer-Encoding`
other than a lone `chunked`, `Transfer-Encoding` beside `Content-Length`, a malformed trailer, and a
2xx with a `Content-Encoding` other than `identity` (the request now sends
`Accept-Encoding: identity`) each fail the fetch. At most 4 interim (`1xx`) responses are skipped,
none with a body, and they share the head's 16 KiB with the final one. A 2xx with neither
`Content-Length` nor `chunked` is refused, since a truncation of a body that ends with its connection
cannot be told from its end. A port of 0 or a host that is no visible ASCII is refused before any
socket. A mutation shard (`a2a-files`) now covers `src/a2a/files` at 100%.
