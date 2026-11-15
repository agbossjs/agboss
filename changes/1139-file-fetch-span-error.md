---
section: Fixed
issue: 1139
---

**A file fetch that fails after a 2xx status line ends its span with an error** (#1139, after
#1021): the span ended with the response and marked an error only for a status of 400 and above,
so a body cut at `maxFileSize`, cut by the deadline or reset by the peer ended `UNSET` with status 200. It now ends `ERROR` with `error.type` `a2a.file-too-large`, `ABORT_ERR` (the deadline or the
request's end) or the body's error code (`ECONNRESET`). A body the peer resets is now refused
`a2a.file-fetch-failed`, as a failed request is, instead of failing the message with an error
that has no stable code.
