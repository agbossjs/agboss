---
section: Fixed
issue: 1092
---

**Pauses no instance can move no longer delay the movable ones when `maxConcurrentSteps` is set**
(#1092, #941): a due pause of another application's tree, of a removed workflow, of an
incompatible version or of a tree another holder has took a place of the expiry look's cap for a
whole 5 s tick, so the movable pauses behind N of them waited about N / cap ticks. Only an expiry that
took its tree (the channel's handler and the pass after it) counts against the cap now; the look
goes past the others within the same tick. The reminder look (#942) follows the same rule: a pause nobody here can remind
takes no place of its cap. No migration.
