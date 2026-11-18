---
section: Fixed
issue: 1329
---

**The stream guard reads the last event of a body that ends without its blank line** (#1329): since the scanner read an event only at its blank line, a body that ended on `data: {"error":{"code":429,…}}\n` was no longer a rate limit but "the stream ended before any content", and a complete answer whose finish event ended in one `\n` failed as "stream ended before it was complete". The scanner now reads the cut last event whole at the end of the body, as the clients do (a cut JSON is still no signal).
