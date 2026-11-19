---
section: Fixed
issue: 1329
---

**A streamed event is bounded, and the stream readers take a payload as the OpenAI client does** (#1329 follow-up): an event of a model's stream that grows past 16 MiB without its blank line fails the call with a typed `EventTooLargeError` (its message names no text of the stream), where it was buffered without a bound. `[DONE]` is where a payload starts, after the one space `data:` drops — no trimming, so the usage report and the stream guard agree with the client on what ends a stream. A refused A2A file fetch (any status but 200, a redirect that stops it) now ends its OpenTelemetry `CLIENT` span as an error, and a 200 that carries a `Content-Range` is refused as a part of a file (#1021, #1312). No migration.
