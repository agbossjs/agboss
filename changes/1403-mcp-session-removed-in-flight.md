---
section: Fixed
issue: 1403
---

**A removed MCP session stays removed** (#1403): a request still in flight when its session was removed re-armed
the session's idle clock when its response closed, so the removed session kept a timer alive. A removed session is
now marked closed, and a late close does nothing to it.
