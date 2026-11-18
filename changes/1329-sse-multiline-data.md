---
section: Fixed
issue: 1329
---

**A streamed answer whose provider cuts one event's JSON over several `data:` lines is recorded at its real cost, with its host** (#1329): the stream's lines were read one by one, so the JSON of such an event was no JSON on any line: its usage was not taken once (the streamed call recorded twice the wire's cost) and its host was lost. An event is now what the SSE spec says — its lines up to a blank line, its `data:` lines joined with a newline, `\n`, `\r\n` and `\r` all ending a line — and one reader of events serves the usage-once and served-by rewrites and the stream guard's signals (an `{error}` cut over two lines is an error again, not silence).
