---
section: Added
issue: 954
---

**A connection whose `onDestroy` the stop abandons gets `onAbandon()` and destroys its socket** (#954, #923): when the shutdown timeout is used up by earlier phases (a recovery sweep's or a child worker's store call that a paused server never answers) the stop abandoned the connection's `onDestroy` while its orderly close was still running, and `close()` returned with a socket open. A component may now have the optional `onAbandon(): void` (`OnAbandon`, from `@agboss/core/stores`): the stop calls it synchronously, once, right after it abandons that component's `onDestroy`, never when `onDestroy` returned in time; a throw is dropped. The stop still never outlives its shutdown timeout.
